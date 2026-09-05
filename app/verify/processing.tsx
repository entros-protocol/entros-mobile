// Verification processing screen. It extracts features, validates the capture,
// encrypts the baseline, generates any required proof, and submits through MWA.
// New validators return the commitment and salt they signed. Older validators
// can accept the client commitment sent for protocol compatibility.
//
// PRIVACY:
// - Captured SensorData is taken once from the buffer and dropped the moment
//   extractFeatures() returns and the audio is encoded for validation.
//   The typed arrays are then eligible for garbage collection.
// - The 256-bit fingerprint AND the previously-stored baseline fingerprint
//   are held only inside the hashing and proof scope. After the scope closes,
//   only the AES ciphertext envelope on disk, the commitment + salt in the
//   handoff buffer, and the proof bytes survive. No plaintext fingerprint
//   leaves this scope.
// - Phrase audio is transient. The validation service must not persist it.
// - Logs include only per-modality non-zero counts, the leading 16 hex
//   chars of the commitment, validate-features outcome category, and proof
//   generation diagnostics (path/proof byte length). Never feature values,
//   never fingerprint bits, never salt values.

import { useRouter } from "expo-router";
import { useEffect, useReducer } from "react";
import { StyleSheet, View } from "react-native";
import { PublicKey } from "@solana/web3.js";

import { ProcessingStage } from "@/components/pulse/ProcessingStage";
import { Screen } from "@/components/primitives/Screen";
import {
  extractFeatures,
  extractProjectionOneCompatibilityFeatures,
  MIN_AUDIO_SAMPLES,
} from "@/extraction";
import { config, getConnection } from "@/config";
import { initialContext, reduce, stageCopy } from "@/flows/verifyMachine";
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
import { parseSubmitError, type ParsedSubmitError } from "@/protocol/errors";
import { fetchIdentityState } from "@/protocol/identity";
import {
  NativeIdentityLayoutUpgradeRequired,
  readNativeProofRequest,
} from "@/protocol/proofRequest";
import type { PreparedNativeProofRequest } from "@/proof/request";
import { fetchProjectionPolicy } from "@/protocol/protocolConfig";
import type { SignedReceiptDto } from "@/protocol/receipt";
import {
  submitProofIdentityUpgrade,
  submitRebaseline,
  submitReset,
  submitVerify,
} from "@/protocol/submit";
import { encodeAudioAsBase64 } from "@/sensor/encode";
import { resampleCurveTrace } from "@/sensor/curve";
import {
  buildValidateFeaturesRequestBody,
  validateFeaturesRequest,
  ValidateOutcome,
} from "@/services/executor";
import { authorizeAndSendValidation } from "@/services/authorizedValidation";
import type { VerificationReason } from "@/services/reasons";
import { useAppState } from "@/state/AppState";
import { clearCapture, takeCapture } from "@/state/captureBuffer";
import { clearChallenge, peekChallenge, takeChallenge } from "@/state/challengeBuffer";
import { clearCommitment, setCommitment, takeCommitment } from "@/state/commitmentBuffer";
import { clearProof, setProof, takeProof } from "@/state/proofBuffer";
import { FailureBucket } from "@/state/types";
import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

export default function Processing() {
  const router = useRouter();
  const { palette } = useTheme();
  const {
    connection,
    dev,
    flow,
    verify,
    resetComplete,
    fail,
    setForceOutcome,
    setFlowIntent,
    updateAuthToken,
  } = useAppState();
  const [ctx, dispatch] = useReducer(reduce, { ...initialContext, state: "extracting" });

  useEffect(() => {
    let cancelled = false;
    const validationController = new AbortController();

    // Snapshot wallet credentials at mount-time. /verify/intro already
    // gates on this, but a parallel disconnect (wallet menu) would
    // otherwise surface a confusing on-chain rejection later. We need
    // all three (address, kind, authToken) for MWA's signAndSendTransaction.
    const walletId = connection.address;
    const walletKind = connection.wallet;
    const initialAuthToken = connection.authToken;
    if (!walletId || !walletKind || !initialAuthToken) {
      router.replace("/connect");
      return;
    }
    let currentAuthToken = initialAuthToken;
    const acceptRotatedAuthToken = async (authToken: string): Promise<void> => {
      const accepted = await updateAuthToken(authToken, walletId, walletKind);
      if (!accepted) {
        throw new Error("The connected wallet changed during signing.");
      }
      currentAuthToken = authToken;
    };
    const flowIntent = flow.intent;

    const failOut = (bucket: FailureBucket, message?: string) => {
      if (cancelled) return;
      fail(bucket);
      setForceOutcome(null);
      router.replace({
        pathname: "/verify/failure",
        params: message ? { bucket, message } : { bucket },
      });
    };

    // Like failOut but does NOT record a failed VerificationEvent in history —
    // for pre-proof, capture-quality retries (Hamming drift / replay floor) that
    // never reached the chain. Matches the soft-reject philosophy: a transient
    // "try again" is not a verification failure. The failure screen is still
    // driven entirely by the bucket param.
    const failOutNoLog = (bucket: FailureBucket) => {
      if (cancelled) return;
      setForceOutcome(null);
      router.replace({ pathname: "/verify/failure", params: { bucket } });
    };

    // Soft-rejects don't count against the verification history (matches
    // the web flow's soft_failed transition) — they're transient retries
    // surfaced through a friendlier UX. Hard buckets above use `failOut`
    // which DOES log to history.
    const routeSoftReject = (reason: VerificationReason) => {
      if (cancelled) return;
      setForceOutcome(null);
      router.replace({
        pathname: "/verify/failure",
        params: { bucket: "soft", reason },
      });
    };

    const routeRateLimited = (retryAfterSec: number) => {
      if (cancelled) return;
      fail("rate-limited");
      setForceOutcome(null);
      router.replace({
        pathname: "/verify/failure",
        params: { bucket: "rate-limited", retryAfter: String(retryAfterSec) },
      });
    };

    const routeFromValidateOutcome = (outcome: Exclude<ValidateOutcome, { kind: "ok" }>) => {
      switch (outcome.kind) {
        case "soft-reject":
          devWarn(`[Entros] /validate-features rejected reason=${outcome.reason}`);
          routeSoftReject(outcome.reason);
          return;
        case "rate-limited":
          devWarn(`[Entros] /validate-features rate-limited retryAfter=${outcome.retryAfterSec}s`);
          routeRateLimited(outcome.retryAfterSec);
          return;
        case "timeout":
          // We aborted the request ourselves, so no verdict exists to record.
          // Route to the transient-retry surface rather than "relayer not
          // connected", and skip the history write for the same reason the
          // taxonomy marks validation_timeout client-origin: nothing was
          // judged, so nothing failed.
          devWarn("[Entros] /validate-features timed out");
          failOutNoLog("retry-now");
          return;
        case "service-down":
          devWarn(`[Entros] /validate-features service-down: ${outcome.message}`);
          failOut("relayer-down");
          return;
        case "payload-too-large":
          // The client assembled a body the executor refused to read. Resending
          // it earns the same rejection, so this is report-and-stop rather than
          // a retry. The diagnostics code is what moves it forward.
          devWarn("[Entros] /validate-features rejected (payload-too-large)");
          failOut("report-bug", "payload_too_large");
          return;
        case "quota-exhausted":
        case "unauthorized":
        case "hard-reject":
        case "unknown":
          devWarn(`[Entros] /validate-features rejected (${outcome.kind})`);
          failOut("generic");
          return;
      }
    };

    // Dev panel override: lets UI testers skip on-chain submission and
    // exercise the success / failure routes directly. Returns true if a
    // dev override fired, false to continue with the real flow.
    const handleDevOverride = (): boolean => {
      const force = dev.forceOutcome;
      if (force === "success") {
        const fakeTxSig = `dev${Math.random().toString(36).slice(2, 10)}…fake`;
        verify(2, fakeTxSig);
        setForceOutcome(null);
        router.replace("/verify/success");
        return true;
      }
      if (force) {
        failOut(force);
        return true;
      }
      return false;
    };

    // Process one captured sample through validation and on-chain submission.
    const runVerify = async () => {
      let captured: ReturnType<typeof takeCapture> = takeCapture();
      if (!captured) {
        // Direct nav (e.g. dev refresh) lands here without a capture buffer.
        // Send the user back to /verify/intro to start a fresh cycle.
        router.replace("/verify/intro");
        return;
      }

      try {
        if (captured.audio.pcm.length < MIN_AUDIO_SAMPLES) {
          failOut(
            "generic",
            "No voice data detected. Please speak the phrase clearly during capture.",
          );
          return;
        }

        let projectionPolicy;
        let chainIdentity;
        try {
          const rpc = getConnection();
          [projectionPolicy, chainIdentity] = await Promise.all([
            fetchProjectionPolicy(rpc),
            fetchIdentityState(new PublicKey(walletId), rpc, true),
          ]);
        } catch (err) {
          failOut(
            "retry-now",
            err instanceof Error ? err.message : "Could not read protocol state.",
          );
          return;
        }
        const projectionVersion = projectionPolicy.current;
        const challenge = peekChallenge();
        if (!challenge) {
          failOut("retry-now", "The server challenge is missing. Start a new capture.");
          return;
        }
        if (challenge.projectionVersion !== projectionVersion) {
          failOut("retry-now", "The protocol projection changed during capture. Start again.");
          return;
        }
        if (performance.now() >= challenge.expiresAtMs) {
          failOut("retry-now", "The server challenge expired. Start a new capture.");
          return;
        }
        const rebaselineRequired =
          chainIdentity !== null && chainIdentity.projectionVersion < projectionVersion;
        if (
          chainIdentity &&
          (chainIdentity.projectionVersion > projectionVersion ||
            (chainIdentity.projectionVersion < projectionPolicy.minimumSupported &&
              !rebaselineRequired))
        ) {
          failOut("report-bug", "The identity projection version is not supported.");
          return;
        }

        const receiptPurpose =
          flowIntent === "reset"
            ? projectionVersion >= 1
              ? "reset"
              : undefined
            : flowIntent === "verify"
              ? !chainIdentity
                ? "mint"
                : rebaselineRequired
                  ? "rebaseline"
                  : undefined
              : undefined;

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

        // Encode audio for /validate-features BEFORE dropping the captured
        // ref so the Float32Array doesn't have to outlive its single use.
        // After this line the only retained audio is the b64 string, which
        // crosses the network.
        let audioSamplesB64: string | undefined = encodeAudioAsBase64(captured.audio.pcm);
        const audioSampleRateHz = captured.audio.sampleRate;
        // Drop the closure ref to the raw sensor buffers — the four largest
        // typed arrays (~768KB audio + motion + touch) become GC-eligible
        // immediately instead of living until submission finishes.
        captured = null;

        const audioNZ = result.raw.slice(0, 170).filter((v) => v !== 0).length;
        const motionNZ = result.raw.slice(170, 251).filter((v) => v !== 0).length;
        const touchNZ = result.raw.slice(251, 308).filter((v) => v !== 0).length;
        // Diagnostic — counts and lengths, never values. Dev-only.
        devWarn(
          `[Entros] features=${result.raw.length} nz=${audioNZ}/${motionNZ}/${touchNZ} f0Frames=${result.f0Contour.length} accelFrames=${result.accelMagnitude.length}`,
        );

        // Load the previous baseline before hashing. Skip this for reset cycles.
        // submitReset takes only the new commitment, no ft_prev needed.
        // First verifications also return null and skip proof
        // generation; mint_anchor takes no proof either.
        let previousBaseline =
          flowIntent !== "reset" && chainIdentity && !rebaselineRequired
            ? await loadBaseline()
            : null;
        if (
          flowIntent === "verify" &&
          chainIdentity &&
          !rebaselineRequired &&
          (!previousBaseline || previousBaseline.projectionVersion !== projectionVersion)
        ) {
          failOut("baseline-missing");
          return;
        }
        if (cancelled) return;

        // The 256-bit fingerprint and the
        // previously-stored baseline fingerprint live only inside this
        // scope; they fall out of scope as soon as the IIFE returns. Only
        // the 16-char commitment hex prefix and the validate outcome
        // (signed receipt + remaining quota) escape for logging and submission.
        //
        // Order is simhash + Poseidon → /validate-features → baseline
        // encryption → Groth16 proof, mirroring the Pulse SDK flow. The
        // commitment must be computed before
        // validation so it can be transmitted as `commitment_new_hex` for
        // the validator to sign.
        type PipelineResult =
          | {
              kind: "ok";
              commitmentHexPrefix: string;
              remainingQuota: number | null;
              signedReceipt: SignedReceiptDto | null;
              firstVerify: boolean;
              rebaseline: boolean;
              preparedBaseline: Awaited<ReturnType<typeof prepareBaseline>>;
            }
          | { kind: "fail"; outcome: Exclude<ValidateOutcome, { kind: "ok" }> }
          | { kind: "cancelled" }
          | { kind: "drift"; bucket: FailureBucket };
        let pipelineResult: PipelineResult;
        try {
          pipelineResult = await (async (): Promise<PipelineResult> => {
            // Compute the SimHash fingerprint and Poseidon commitment.
            const fingerprint = simhash(result.normalized, projectionVersion);
            // Local TBH with a client-random salt is the fallback used when the
            // validator doesn't return a server-derived commitment (older
            // deploys). When it does, we swap in the server's salt + commitment
            // below (C2); the fingerprint stays ours either way.
            let tbh = await generateTBH(fingerprint);
            const commitmentNewHex = Array.from(tbh.commitmentBytes)
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");

            // Advance before the request so the UI shows the validation state.
            // The validator binds its receipt to commitment_new_hex.
            if (cancelled) return { kind: "cancelled" };
            dispatch({ type: "advance" });

            const requestBody = buildValidateFeaturesRequestBody({
              features: result.raw,
              projectionVersion,
              walletId,
              f0Contour: result.f0Contour,
              accelMagnitude: result.accelMagnitude,
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
                  walletAddress: walletId,
                  walletKind,
                  authToken: currentAuthToken,
                  onAuthTokenRotated: acceptRotatedAuthToken,
                  isCancelled: () => cancelled,
                  signal: validationController.signal,
                });
                if (authorized.kind === "cancelled") return { kind: "cancelled" };
                if (authorized.kind === "expired") {
                  return { kind: "drift", bucket: "retry-now" };
                }
                currentAuthToken = authorized.authToken;
                outcome = authorized.outcome;
              } else {
                outcome = await validateFeaturesRequest(requestBody, {
                  deadlineAtMs: challenge.expiresAtMs,
                  signal: validationController.signal,
                });
              }
            } finally {
              requestBody.audio_samples_b64 = undefined;
            }
            if (cancelled) return { kind: "cancelled" };
            if (outcome.kind !== "ok") return { kind: "fail", outcome };

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
            dispatch({ type: "advance" });

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
              const proofStartedAt = Date.now();
              let preparedRequest: PreparedNativeProofRequest | undefined;
              const proofManifest = config.proofManifest;
              if (proofManifest) {
                const readRequest = () =>
                  readNativeProofRequest(
                    getConnection(),
                    proofManifest,
                    walletId,
                    challenge.nonce,
                    {
                      commitmentNew: commitmentNewHex,
                      commitmentPrevious: previousCommitment.toString(16).padStart(64, "0"),
                      threshold: DEFAULT_THRESHOLD,
                      minDistance: DEFAULT_MIN_DISTANCE,
                    },
                  );
                try {
                  preparedRequest = await readRequest();
                } catch (error) {
                  if (!(error instanceof NativeIdentityLayoutUpgradeRequired)) throw error;
                  if (handleDevOverride()) return { kind: "cancelled" };
                  const upgraded = await submitProofIdentityUpgrade({
                    walletAddress: walletId,
                    authToken: currentAuthToken,
                    walletKind,
                    onAuthTokenRotated: acceptRotatedAuthToken,
                  });
                  currentAuthToken = upgraded.authToken;
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
            };
          })();
        } finally {
          audioSamplesB64 = undefined;
          previousBaseline?.fingerprint.fill(0);
          previousBaseline = null;
          compatibilityEvidence?.features.fill(0);
          compatibilityEvidence = undefined;
          result.raw.fill(0);
          result.normalized.fill(0);
          result.f0Contour.fill(0);
          result.accelMagnitude.fill(0);
        }
        if (pipelineResult.kind === "cancelled" || cancelled) return;

        if (pipelineResult.kind === "fail") {
          routeFromValidateOutcome(pipelineResult.outcome);
          return;
        }

        if (pipelineResult.kind === "drift") {
          // Pre-flight Hamming bounds rejection — drift past the consistency
          // ceiling (capture-drift) or below the replay floor (generic/opaque).
          // Route to a friendly retry surface without proving or signing, and
          // without logging it as a failed verification (it never reached the
          // chain).
          failOutNoLog(pipelineResult.bucket);
          return;
        }

        const {
          commitmentHexPrefix,
          remainingQuota,
          signedReceipt,
          firstVerify,
          rebaseline,
          preparedBaseline,
        } = pipelineResult;
        devWarn(`[Entros] /validate-features ok q=${remainingQuota ?? "?"}`);
        // Diagnostic — first 8 bytes (16 hex chars) only. Never the full
        // 32-byte commitment, never the fingerprint bits, never the salt.
        // The receipt is logged only as "present" / "absent" so the dev
        // can confirm receipt wiring without leaking validator-signed
        // bytes (public protocol artefacts, but log noise either way).
        devWarn(
          `[Entros] commitment=${commitmentHexPrefix}… intent=${flowIntent} firstVerify=${firstVerify} receipt=${signedReceipt ? "present" : "absent"}`,
        );

        // Dev panel override fires before any on-chain work — lets UI
        // testers skip the wallet round-trip. Real path falls through.
        if (handleDevOverride()) return;

        // Take the buffered values for on-chain submission. None survives.
        const commitmentBuf = takeCommitment();
        const proofBuf = takeProof();
        const challengeBuf = takeChallenge();
        if (!commitmentBuf) {
          // Hashing always populates this slot.
          failOut("generic", "Internal error: commitment slot was empty.");
          return;
        }

        dispatch({ type: "advance" }); // → "signing"

        try {
          let result;
          if (flowIntent === "reset") {
            result = await submitReset(
              {
                walletAddress: walletId,
                authToken: currentAuthToken,
                walletKind,
                commitment: commitmentBuf.commitmentBytes,
                projectionVersion,
                signedReceipt: signedReceipt ?? undefined,
                onAuthTokenRotated: acceptRotatedAuthToken,
              },
              () => dispatch({ type: "advance" }), // → "submitting" once signed
            );
          } else if (rebaseline) {
            if (!signedReceipt) {
              throw new Error("Projection migration requires a validator-signed receipt.");
            }
            result = await submitRebaseline(
              {
                walletAddress: walletId,
                authToken: currentAuthToken,
                walletKind,
                commitment: commitmentBuf.commitmentBytes,
                projectionVersion,
                signedReceipt,
                onAuthTokenRotated: acceptRotatedAuthToken,
              },
              () => dispatch({ type: "advance" }),
            );
          } else {
            const nonce = challengeBuf?.nonce ? Array.from(challengeBuf.nonce) : undefined;
            result = await submitVerify(
              {
                walletAddress: walletId,
                authToken: currentAuthToken,
                walletKind,
                commitment: commitmentBuf.commitmentBytes,
                isFirstVerify: firstVerify,
                proof: proofBuf ?? undefined,
                nonce,
                // First-verify only — submit.ts ignores it on the re-verify
                // branch. Receipt is the validator's Ed25519-signed binding
                // to (wallet, commitment, validated_at).
                // The first-verification path requires this receipt.
                // Re-verification ignores it.
                signedReceipt: signedReceipt ?? undefined,
                onAuthTokenRotated: acceptRotatedAuthToken,
              },
              () => dispatch({ type: "advance" }), // → "submitting" once signed
            );
          }
          if (cancelled) return;

          try {
            await persistPreparedBaseline(preparedBaseline);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            devWarn(`[Entros] baseline persistence failed after confirmation: ${message}`);
          }

          devWarn(
            `[Entros] on-chain ok intent=${flowIntent} sig=${result.txSignature.slice(0, 12)}…`,
          );

          // Reset the verify-flow intent so the NEXT cycle is a normal
          // verify by default. Failure path leaves the intent intact so a
          // retry stays on the reset path.
          if (flowIntent === "reset") {
            setFlowIntent("verify");
            resetComplete(result.txSignature);
          } else {
            verify(2, result.txSignature);
          }
          setForceOutcome(null);
          router.replace("/verify/success");
        } catch (err) {
          if (cancelled) return;
          const parsed: ParsedSubmitError = parseSubmitError(err);
          devWarn(
            `[Entros] on-chain submit failed kind=${parsed.kind} code=${parsed.anchorCode ?? "?"} raw=${parsed.raw.slice(0, 200)}`,
          );

          // Map parsed kind → FailureBucket. wallet-rejected is the one
          // silent path: the user explicitly cancelled in their wallet's
          // approval UI, so re-routing them straight to /verify/intro
          // (no failure screen) matches the natural "I changed my mind"
          // mental model.
          if (parsed.kind === "wallet-rejected") {
            setForceOutcome(null);
            router.replace("/verify/intro");
            return;
          }

          switch (parsed.kind) {
            case "anchor-already-exists":
              failOut(
                "baseline-missing",
                "It looks like you already have an Anchor on this wallet. Reset to re-enroll.",
              );
              return;
            case "insufficient-funds":
              failOut("insufficient-funds");
              return;
            case "cooldown-active":
              failOut("chain-rate-limited");
              return;
            case "receipt-rejected":
              failOut("validator-mismatch");
              return;
            case "wallet-timeout":
            case "stale-blockhash":
            case "challenge-stale":
            case "clock-drift":
            case "network-unreachable":
              failOut("retry-now");
              return;
            case "proof-rejected":
            case "commitment-binding":
            case "programming-error":
              failOut(
                "report-bug",
                `${parsed.kind}${parsed.anchorCode ? ` (${parsed.anchorCode})` : ""}`,
              );
              return;
            case "wallet-not-installed":
            case "wallet-authorization-failed":
            case "generic":
            default:
              failOut("generic", parsed.raw);
              return;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Verification failed.";
        failOut("generic", message);
      }
    };

    void runVerify();
    return () => {
      cancelled = true;
      validationController.abort();
      // Defence-in-depth: clear all four handoff slots if the screen
      // unmounts mid-flow (back nav, app suspend, etc.). The next verify
      // cycle starts from a known-empty state.
      clearCapture();
      clearCommitment();
      clearChallenge();
      clearProof();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ctx.state drives the display; the reducer linearly advances
  // extracting → validating → computing → signing → submitting → success.
  const display = stageCopy[ctx.state] ?? stageCopy.extracting;

  return (
    <Screen>
      <View style={styles.wrap}>
        <ProcessingStage
          title={display?.title ?? "Working"}
          subtitle={display?.subtitle}
          spinnerColor={display?.spinnerColor === "purple" ? palette.solanaPurple : palette.accent}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: spacing.hero },
});
