// The verification pipeline after feature extraction: fingerprint and
// commitment, an injected validation step, baseline preparation, the update
// proof, and the on-chain submission. The single capture and the paired
// session share it and differ only in how they validate.
//
// New validators return the commitment and salt they signed. Older validators
// can accept the client commitment sent for protocol compatibility.
//
// PRIVACY:
// - The 256-bit fingerprint AND the previously-stored baseline fingerprint
//   are held only inside the hashing and proof scope. After the scope closes,
//   only the AES ciphertext envelope on disk, the commitment + salt in the
//   handoff buffer, and the proof bytes survive. No plaintext fingerprint
//   leaves this scope.
// - The extracted feature arrays are zero-filled once validation and the
//   proof are done.
// - Logs include only per-modality non-zero counts, the leading 16 hex
//   chars of the commitment, the validation outcome category, and proof
//   generation diagnostics (path/proof byte length). Never feature values,
//   never fingerprint bits, never salt values.

import { config, getConnection } from "@/config";
import { extractFeatures, extractProjectionOneCompatibilityFeatures } from "@/extraction";
import type { ExtractedFeatures } from "@/extraction";
import {
  bigintToBytes32,
  computeCommitment,
  generateTBH,
  hammingDistance,
  simhash,
} from "@/hashing";
import type { TBH } from "@/hashing";
import { loadBaseline, persistPreparedBaseline, prepareBaseline } from "@/identity/baseline";
import { devWarn } from "@/lib/log";
import { classifyHammingDistance, DEFAULT_MIN_DISTANCE, DEFAULT_THRESHOLD } from "@/proof";
import { generateSolanaProof } from "@/proof/prover";
import type { PreparedNativeProofRequest } from "@/proof/request";
import { parseSubmitError, type ParsedSubmitError } from "@/protocol/errors";
import {
  NativeIdentityLayoutUpgradeRequired,
  readNativeProofRequest,
} from "@/protocol/proofRequest";
import type { SignedReceiptDto } from "@/protocol/receipt";
import {
  submitProofIdentityUpgrade,
  submitRebaseline,
  submitReset,
  submitVerify,
} from "@/protocol/submit";
import { resampleCurveTrace } from "@/sensor/curve";
import { encodeAudioAsBase64 } from "@/sensor/encode";
import type { SensorData } from "@/sensor/types";
import { authorizeAndSendValidation } from "@/services/authorizedValidation";
import {
  buildValidateFeaturesRequestBody,
  validateFeaturesRequest,
  type ValidateOutcome,
} from "@/services/executor";
import { setCommitment, takeCommitment } from "@/state/commitmentBuffer";
import { setProof, takeProof } from "@/state/proofBuffer";
import type { FailureBucket, VerifyIntent, WalletKind } from "@/state/types";

export type ReceiptPurposeName = "mint" | "rebaseline" | "reset";
export type ValidatedOutcome = Extract<ValidateOutcome, { kind: "ok" }>;

/** The wallet a verification signs with. Tracks the MWA token as it rotates. */
export class WalletSession {
  private token: string;

  constructor(
    readonly address: string,
    readonly kind: WalletKind,
    authToken: string,
    private readonly persist: (
      authToken: string,
      address: string,
      kind: WalletKind,
    ) => Promise<boolean>,
  ) {
    this.token = authToken;
  }

  get authToken(): string {
    return this.token;
  }

  /** Adopts a token an MWA call returned after `acceptRotated` stored it. */
  adopt(authToken: string): void {
    this.token = authToken;
  }

  /** Stores a rotated token. Throws when the connected wallet changed. */
  readonly acceptRotated = async (authToken: string): Promise<void> => {
    const accepted = await this.persist(authToken, this.address, this.kind);
    if (!accepted) {
      throw new Error("The connected wallet changed during signing.");
    }
    this.token = authToken;
  };
}

/** What the pipeline hands the validation step. */
export interface ValidationRequest {
  features: number[];
  f0Contour: number[];
  accelMagnitude: number[];
  /** Lowercase hex of the client commitment, for validators that sign it. */
  commitmentNewHex: string;
}

/** `F` is the failure shape the caller routes. The pipeline passes it through. */
export type ValidationStepResult<F> =
  | { kind: "ok"; outcome: ValidatedOutcome }
  | { kind: "failed"; failure: F }
  | { kind: "cancelled" }
  | { kind: "drift"; bucket: FailureBucket };

export type ValidationStep<F> = (request: ValidationRequest) => Promise<ValidationStepResult<F>>;

export interface PipelineInput<F> {
  wallet: WalletSession;
  flowIntent: VerifyIntent;
  projectionVersion: number;
  chainIdentity: { projectionVersion: number } | null;
  rebaselineRequired: boolean;
  /** Zero-filled by the pipeline once validation and the proof are done. */
  extracted: ExtractedFeatures;
  validate: ValidationStep<F>;
  /** The nonce the update proof and its on-chain challenge bind. */
  proofNonce(): Promise<Uint8Array>;
  isCancelled(): boolean;
  /** Moves the visible stage forward one step. */
  onAdvance(): void;
  /** Runs a dev-panel override. Returns true when it handled the outcome. */
  devOverride(): boolean;
  /** Runs where the handoff buffers are taken for signing. */
  beforeSigning?(): void;
  /** Releases what the validation step holds, alongside the feature arrays. */
  release?(): void;
}

export type PipelineOutcome<F> =
  | { kind: "success"; txSignature: string }
  | { kind: "validation-failed"; failure: F }
  /** A pre-proof retry that never reached the chain. Not recorded as a failure. */
  | { kind: "retry"; bucket: FailureBucket }
  | { kind: "failed"; bucket: FailureBucket; message?: string }
  | { kind: "wallet-rejected" }
  /** The screen went away or a dev override already routed. Nothing is left to do. */
  | { kind: "cancelled" };

type ProofStage<F> =
  | {
      kind: "ok";
      commitmentHexPrefix: string;
      remainingQuota: number | null;
      signedReceipt: SignedReceiptDto | null;
      firstVerify: boolean;
      rebaseline: boolean;
      preparedBaseline: Awaited<ReturnType<typeof prepareBaseline>>;
      nonce: Uint8Array | undefined;
    }
  | { kind: "failed"; failure: F }
  | { kind: "cancelled" }
  | { kind: "drift"; bucket: FailureBucket };

/** Maps a parsed on-chain submission failure to its failure screen. */
function outcomeForSubmitError<F>(parsed: ParsedSubmitError): PipelineOutcome<F> {
  // wallet-rejected is the one silent path: the user explicitly cancelled in
  // their wallet's approval UI, so re-routing them straight to /verify/intro
  // (no failure screen) matches the natural "I changed my mind" mental model.
  switch (parsed.kind) {
    case "wallet-rejected":
      return { kind: "wallet-rejected" };
    case "anchor-already-exists":
      return {
        kind: "failed",
        bucket: "baseline-missing",
        message: "It looks like you already have an Anchor on this wallet. Reset to re-enroll.",
      };
    case "insufficient-funds":
      return { kind: "failed", bucket: "insufficient-funds" };
    case "cooldown-active":
      return { kind: "failed", bucket: "chain-rate-limited" };
    case "receipt-rejected":
      return { kind: "failed", bucket: "validator-mismatch" };
    case "wallet-timeout":
    case "stale-blockhash":
    case "challenge-stale":
    case "clock-drift":
    case "network-unreachable":
      return { kind: "failed", bucket: "retry-now" };
    case "proof-rejected":
    case "commitment-binding":
    case "programming-error":
      return {
        kind: "failed",
        bucket: "report-bug",
        message: `${parsed.kind}${parsed.anchorCode ? ` (${parsed.anchorCode})` : ""}`,
      };
    case "wallet-not-installed":
    case "wallet-authorization-failed":
    case "generic":
    default:
      return { kind: "failed", bucket: "generic", message: parsed.raw };
  }
}

/**
 * Runs everything after feature extraction. Order is simhash + Poseidon →
 * validation → baseline encryption → Groth16 proof → on-chain submission,
 * mirroring the Pulse SDK flow. The commitment is computed before validation
 * so it can be transmitted for the validator to sign.
 */
export async function runVerificationPipeline<F>(
  input: PipelineInput<F>,
): Promise<PipelineOutcome<F>> {
  const {
    extracted: result,
    wallet,
    flowIntent,
    projectionVersion,
    chainIdentity,
    rebaselineRequired,
  } = input;

  const audioNZ = result.raw.slice(0, 170).filter((v) => v !== 0).length;
  const motionNZ = result.raw.slice(170, 251).filter((v) => v !== 0).length;
  const touchNZ = result.raw.slice(251, 308).filter((v) => v !== 0).length;
  // Diagnostic counts and lengths, never values. Dev-only.
  devWarn(
    `[Entros] features=${result.raw.length} nz=${audioNZ}/${motionNZ}/${touchNZ} f0Frames=${result.f0Contour.length} accelFrames=${result.accelMagnitude.length}`,
  );

  // Load the previous baseline before hashing. Skip this for reset cycles.
  // submitReset takes only the new commitment, no ft_prev needed.
  // First verifications also return null and skip proof
  // generation; mint_anchor takes no proof either.
  let previousBaseline =
    flowIntent !== "reset" && chainIdentity && !rebaselineRequired ? await loadBaseline() : null;
  if (
    flowIntent === "verify" &&
    chainIdentity &&
    !rebaselineRequired &&
    (!previousBaseline || previousBaseline.projectionVersion !== projectionVersion)
  ) {
    return { kind: "failed", bucket: "baseline-missing" };
  }
  if (input.isCancelled()) return { kind: "cancelled" };

  // The 256-bit fingerprint and the previously-stored baseline fingerprint
  // live only inside this scope; they fall out of scope as soon as the
  // function returns. Only the 16-char commitment hex prefix and the
  // validation outcome (signed receipt + remaining quota) escape for logging
  // and submission.
  let stage: ProofStage<F>;
  try {
    stage = await (async (): Promise<ProofStage<F>> => {
      // Compute the SimHash fingerprint and Poseidon commitment.
      const fingerprint = simhash(result.normalized, projectionVersion);
      // Local TBH with a client-random salt is the fallback used when the
      // validator doesn't return a server-derived commitment (older
      // deploys). When it does, we swap in the server's salt + commitment
      // below; the fingerprint stays ours either way.
      let tbh = await generateTBH(fingerprint);
      const commitmentNewHex = Array.from(tbh.commitmentBytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      // Advance before the request so the UI shows the validation state.
      if (input.isCancelled()) return { kind: "cancelled" };
      input.onAdvance();

      const validation = await input.validate({
        features: result.raw,
        f0Contour: result.f0Contour,
        accelMagnitude: result.accelMagnitude,
        commitmentNewHex,
      });
      if (validation.kind === "drift") return validation;
      if (input.isCancelled() || validation.kind === "cancelled") return { kind: "cancelled" };
      if (validation.kind === "failed") return validation;
      const outcome = validation.outcome;

      // Adopt the validator-derived commitment and salt.
      // `mint_anchor` enforces the commitment computed from these features.
      // Every later consumer reads this replacement value.
      if (outcome.commitmentHex && outcome.saltHex) {
        const serverCommitment = BigInt("0x" + outcome.commitmentHex);
        const serverSalt = BigInt("0x" + outcome.saltHex);
        tbh = {
          fingerprint,
          salt: serverSalt,
          commitment: serverCommitment,
          commitmentBytes: bigintToBytes32(serverCommitment),
        };
        if (__DEV__) {
          // A mismatch means the installed app and validator have drifted.
          // Future rotation proofs would fail to open.
          const localCheck = await computeCommitment(fingerprint, serverSalt);
          if (localCheck !== serverCommitment) {
            devWarn(
              "[Entros] Commitment parity check failed: validator-derived commitment != local recomputation. Mobile and validator may be out of sync.",
            );
          }
        }
      }

      // Advance to "computing" before baseline and proof work so the UI
      // shows the "Generating ZK proof" copy while AES-GCM + arkworks
      // proof generation run.
      input.onAdvance();

      // Prepare the encrypted baseline. The ciphertext remains
      // in memory until the on-chain transaction confirms.
      setCommitment({
        commitment: tbh.commitment,
        salt: tbh.salt,
        commitmentBytes: tbh.commitmentBytes,
      });
      let preparedBaseline;
      try {
        preparedBaseline = await prepareBaseline({
          fingerprint: tbh.fingerprint,
          salt: tbh.salt.toString(),
          commitment: tbh.commitment.toString(),
          timestamp: Date.now(),
          projectionVersion,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        devWarn(`[Entros] baseline preparation failed: ${message}`);
        return { kind: "drift", bucket: "report-bug" };
      }

      // Generate the Groth16 proof on-device for re-verification only.
      // The first verification skips this because mint_anchor takes no proof.
      let nonce: Uint8Array | undefined;
      if (previousBaseline) {
        const previousCommitment = BigInt(previousBaseline.commitment);
        const previousTbh: TBH = {
          fingerprint: previousBaseline.fingerprint,
          salt: BigInt(previousBaseline.salt),
          commitment: previousCommitment,
          commitmentBytes: bigintToBytes32(previousCommitment),
        };
        // Pre-flight: classify the Hamming distance against the same band
        // the circuit enforces (entros_hamming.circom). A drift past the
        // ceiling would otherwise throw a raw circom assertion.
        // Route drift to a clean retry before proving or signing.
        // Keep captures below the replay floor opaque.
        const verdict = classifyHammingDistance(
          hammingDistance(tbh.fingerprint, previousTbh.fingerprint),
          DEFAULT_THRESHOLD,
          DEFAULT_MIN_DISTANCE,
        );
        if (verdict === "drift_too_high") return { kind: "drift", bucket: "capture-drift" };
        if (verdict === "below_min_distance") return { kind: "drift", bucket: "generic" };
        const proofNonce = await input.proofNonce();
        nonce = proofNonce;
        const proofStartedAt = Date.now();
        let preparedRequest: PreparedNativeProofRequest | undefined;
        const proofManifest = config.proofManifest;
        if (proofManifest) {
          const readRequest = () =>
            readNativeProofRequest(getConnection(), proofManifest, wallet.address, proofNonce, {
              commitmentNew: commitmentNewHex,
              commitmentPrevious: previousCommitment.toString(16).padStart(64, "0"),
              threshold: DEFAULT_THRESHOLD,
              minDistance: DEFAULT_MIN_DISTANCE,
            });
          try {
            preparedRequest = await readRequest();
          } catch (error) {
            if (!(error instanceof NativeIdentityLayoutUpgradeRequired)) throw error;
            if (input.devOverride()) return { kind: "cancelled" };
            const upgraded = await submitProofIdentityUpgrade({
              walletAddress: wallet.address,
              authToken: wallet.authToken,
              walletKind: wallet.kind,
              onAuthTokenRotated: wallet.acceptRotated,
            });
            wallet.adopt(upgraded.authToken);
            preparedRequest = await readRequest();
          }
        }
        const solanaProof = await generateSolanaProof(tbh, previousTbh, preparedRequest);
        const proofMs = Date.now() - proofStartedAt;
        setProof(solanaProof);
        devWarn(
          `[Entros] proof bytes=${solanaProof.proofBytes.length} publicInputs=${solanaProof.publicInputs.length} ms=${proofMs}`,
        );
      }

      return {
        kind: "ok",
        commitmentHexPrefix: commitmentNewHex.slice(0, 16),
        remainingQuota: outcome.remainingQuota,
        signedReceipt: outcome.signedReceipt,
        firstVerify: chainIdentity === null,
        rebaseline: rebaselineRequired,
        preparedBaseline,
        nonce,
      };
    })();
  } finally {
    previousBaseline?.fingerprint.fill(0);
    previousBaseline = null;
    input.release?.();
    result.raw.fill(0);
    result.normalized.fill(0);
    result.f0Contour.fill(0);
    result.accelMagnitude.fill(0);
  }
  if (stage.kind === "cancelled" || input.isCancelled()) return { kind: "cancelled" };

  if (stage.kind === "failed") return { kind: "validation-failed", failure: stage.failure };

  if (stage.kind === "drift") {
    // Pre-flight Hamming bounds rejection: drift past the consistency
    // ceiling (capture-drift) or below the replay floor (generic/opaque).
    // Route to a friendly retry surface without proving or signing, and
    // without logging it as a failed verification (it never reached the
    // chain).
    return { kind: "retry", bucket: stage.bucket };
  }

  const {
    commitmentHexPrefix,
    remainingQuota,
    signedReceipt,
    firstVerify,
    rebaseline,
    preparedBaseline,
    nonce,
  } = stage;
  devWarn(`[Entros] validation ok q=${remainingQuota ?? "?"}`);
  // Diagnostic: first 8 bytes (16 hex chars) only. Never the full
  // 32-byte commitment, never the fingerprint bits, never the salt.
  // The receipt is logged only as "present" / "absent" so the dev
  // can confirm receipt wiring without leaking validator-signed
  // bytes (public protocol artefacts, but log noise either way).
  devWarn(
    `[Entros] commitment=${commitmentHexPrefix}… intent=${flowIntent} firstVerify=${firstVerify} receipt=${signedReceipt ? "present" : "absent"}`,
  );

  // Dev panel override fires before any on-chain work, so UI
  // testers skip the wallet round-trip. Real path falls through.
  if (input.devOverride()) return { kind: "cancelled" };

  // Take the buffered values for on-chain submission. None survives.
  const commitmentBuf = takeCommitment();
  const proofBuf = takeProof();
  input.beforeSigning?.();
  if (!commitmentBuf) {
    // Hashing always populates this slot.
    return {
      kind: "failed",
      bucket: "generic",
      message: "Internal error: commitment slot was empty.",
    };
  }

  input.onAdvance(); // → "signing"

  try {
    let submitted;
    if (flowIntent === "reset") {
      submitted = await submitReset(
        {
          walletAddress: wallet.address,
          authToken: wallet.authToken,
          walletKind: wallet.kind,
          commitment: commitmentBuf.commitmentBytes,
          projectionVersion,
          signedReceipt: signedReceipt ?? undefined,
          onAuthTokenRotated: wallet.acceptRotated,
        },
        () => input.onAdvance(), // → "submitting" once signed
      );
    } else if (rebaseline) {
      if (!signedReceipt) {
        throw new Error("Projection migration requires a validator-signed receipt.");
      }
      submitted = await submitRebaseline(
        {
          walletAddress: wallet.address,
          authToken: wallet.authToken,
          walletKind: wallet.kind,
          commitment: commitmentBuf.commitmentBytes,
          projectionVersion,
          signedReceipt,
          onAuthTokenRotated: wallet.acceptRotated,
        },
        () => input.onAdvance(),
      );
    } else {
      submitted = await submitVerify(
        {
          walletAddress: wallet.address,
          authToken: wallet.authToken,
          walletKind: wallet.kind,
          commitment: commitmentBuf.commitmentBytes,
          isFirstVerify: firstVerify,
          proof: proofBuf ?? undefined,
          nonce: nonce ? Array.from(nonce) : undefined,
          // First-verify only. submit.ts ignores it on the re-verify
          // branch. Receipt is the validator's Ed25519-signed binding
          // to (wallet, commitment, validated_at).
          // The first-verification path requires this receipt.
          // Re-verification ignores it.
          signedReceipt: signedReceipt ?? undefined,
          onAuthTokenRotated: wallet.acceptRotated,
        },
        () => input.onAdvance(), // → "submitting" once signed
      );
    }
    if (input.isCancelled()) return { kind: "cancelled" };

    try {
      await persistPreparedBaseline(preparedBaseline);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      devWarn(`[Entros] baseline persistence failed after confirmation: ${message}`);
    }

    devWarn(`[Entros] on-chain ok intent=${flowIntent} sig=${submitted.txSignature.slice(0, 12)}…`);
    return { kind: "success", txSignature: submitted.txSignature };
  } catch (err) {
    if (input.isCancelled()) return { kind: "cancelled" };
    const parsed: ParsedSubmitError = parseSubmitError(err);
    devWarn(
      `[Entros] on-chain submit failed kind=${parsed.kind} code=${parsed.anchorCode ?? "?"} raw=${parsed.raw.slice(0, 200)}`,
    );
    return outcomeForSubmitError(parsed);
  }
}

/** A single capture ready for the pipeline, and the validation step that posts it. */
export interface PreparedSingleCapture {
  extracted: ExtractedFeatures;
  validate: ValidationStep<Exclude<ValidateOutcome, { kind: "ok" }>>;
  /** Drops the transient phrase audio and compatibility evidence. */
  release(): void;
}

export interface SingleCaptureContext {
  wallet: WalletSession;
  projectionVersion: number;
  receiptPurpose: ReceiptPurposeName | undefined;
  challenge: { nonce: Uint8Array; expiresAtMs: number };
  isCancelled(): boolean;
  signal: AbortSignal;
}

/**
 * Extracts a single capture's features and builds its `/validate-features`
 * step. The caller drops its reference to `captured` once this resolves: the
 * phrase audio then survives only as the base64 string the step sends once.
 */
export async function prepareSingleCapture(
  captured: SensorData,
  context: SingleCaptureContext,
): Promise<PreparedSingleCapture> {
  const { projectionVersion, receiptPurpose, wallet, challenge } = context;
  const result = await extractFeatures(captured, projectionVersion);
  let compatibilityEvidence =
    projectionVersion === 2 && receiptPurpose !== undefined
      ? {
          projection_version: 1,
          feature_schema_version: 4,
          features: await extractProjectionOneCompatibilityFeatures(captured, result.raw),
        }
      : undefined;
  const curveTrace = captured.touch.curveTrace
    ? resampleCurveTrace(captured.touch.curveTrace)
    : undefined;

  // Encode audio for /validate-features before the caller drops the captured
  // ref so the Float32Array doesn't have to outlive its single use. After
  // this line the only retained audio is the b64 string, which crosses the
  // network.
  let audioSamplesB64: string | undefined = encodeAudioAsBase64(captured.audio.pcm);
  const audioSampleRateHz = captured.audio.sampleRate;

  const validate: PreparedSingleCapture["validate"] = async ({
    features,
    f0Contour,
    accelMagnitude,
    commitmentNewHex,
  }) => {
    // The validator binds its receipt to commitment_new_hex.
    const requestBody = buildValidateFeaturesRequestBody({
      features,
      projectionVersion,
      walletId: wallet.address,
      f0Contour,
      accelMagnitude,
      audioSamplesB64,
      audioSampleRateHz,
      commitmentNewHex,
      receiptPurpose,
      compatibilityEvidence,
      curveTrace,
    });
    audioSamplesB64 = undefined;
    let outcome: ValidateOutcome;
    try {
      if (projectionVersion === 2) {
        const authorized = await authorizeAndSendValidation({
          requestBody,
          nonce: challenge.nonce,
          expiresAtMs: challenge.expiresAtMs,
          walletAddress: wallet.address,
          walletKind: wallet.kind,
          authToken: wallet.authToken,
          onAuthTokenRotated: wallet.acceptRotated,
          isCancelled: context.isCancelled,
          signal: context.signal,
        });
        if (authorized.kind === "cancelled") return { kind: "cancelled" };
        if (authorized.kind === "expired") {
          return { kind: "drift", bucket: "retry-now" };
        }
        wallet.adopt(authorized.authToken);
        outcome = authorized.outcome;
      } else {
        outcome = await validateFeaturesRequest(requestBody, {
          deadlineAtMs: challenge.expiresAtMs,
          signal: context.signal,
        });
      }
    } finally {
      requestBody.audio_samples_b64 = undefined;
    }
    if (context.isCancelled()) return { kind: "cancelled" };
    if (outcome.kind !== "ok") return { kind: "failed", failure: outcome };
    return { kind: "ok", outcome };
  };

  return {
    extracted: result,
    validate,
    release() {
      audioSamplesB64 = undefined;
      compatibilityEvidence?.features.fill(0);
      compatibilityEvidence = undefined;
    },
  };
}
