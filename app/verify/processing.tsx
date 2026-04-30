// Verification processing screen.
//
// Stages 1–7 are all real:
// - Stage 1 (sensor capture) runs in /verify/capture and lands in the buffer.
// - Stage 2 (134-feature extraction) runs in the `extracting` step here.
// - Stage 3 (SimHash + Poseidon TBH) runs FIRST inside the stages IIFE,
//   producing the 32-byte commitment that all forward stages — including
//   Stage 4 — depend on. Mirrors pulse-sdk pulse.ts:148-291 (master-list
//   #146 Phase 4): the commitment must be transmitted as `commitment_new_hex`
//   so the validator can sign a (wallet, commitment, validated_at) receipt
//   bundled before mint_anchor on first-verify.
// - Stage 4 (server-side validation) POSTs the 134-feature vector + cross-
//   modal time-series + audio b64 + commitment_new_hex to the executor's
//   /validate-features endpoint, surfacing soft-rejects with a friendly
//   retry UX and routing service / rate-limit errors to the appropriate
//   failure bucket. The signed receipt comes back on the ok outcome.
// - Stage 5 (encrypted baseline persistence) encrypts the
//   {fingerprint, salt, commitment, timestamp} bundle with AES-256-GCM
//   inside the same IIFE as Stage 3 so the fingerprint never escapes its
//   tight scope. Ciphertext lives in expo-secure-store under
//   `entros.v1.baseline.envelope`; the AES key under `entros.v1.baseline.key`.
// - Stage 6 (Groth16 ZK proof) runs ONLY on re-verify (when a previous
//   baseline exists AND flow.intent === "verify"). The mopro native
//   module proves HammingDistance(ft_new, ft_prev) ∈ [3, 96) without
//   revealing either fingerprint, then we serialise to the 256-byte
//   groth16-solana format. First-verify and reset cycles skip proof
//   generation. The proof byte payload is held in `proofBuffer`.
// - Stage 7 (on-chain submit via MWA) is the terminal step. Branches on
//   flow.intent + previousBaseline:
//   - intent="verify" + no prior baseline → (optional Ed25519 receipt) +
//                                            mint_anchor
//   - intent="verify" + prior baseline → ComputeBudget + create_challenge
//                                        + verify_proof + update_anchor batch
//   - intent="reset"                    → ComputeBudget + reset_identity_state
//
// PRIVACY:
// - Captured SensorData is taken once from the buffer and dropped the moment
//   extractFeatures() returns + the audio is base64-encoded for /validate-
//   features. After that the typed arrays are GC-eligible immediately
//   instead of living until the simulated stages finish.
// - The 256-bit fingerprint AND the previously-stored baseline fingerprint
//   are held only inside the Stages 3+5+6 IIFE (simhash → generateTBH →
//   storeBaseline → optional generateSolanaProof). After the IIFE closes,
//   only the AES ciphertext envelope on disk, the commitment + salt in the
//   handoff buffer, and the 256-byte ZK proof bytes (zero-knowledge by
//   construction) survive — no plaintext fingerprint anywhere.
// - Audio b64 is the single sanctioned exception (paper §6.8 +
//   src/sensor/types.ts:7-8). The validation service runs Whisper-tiny on
//   it ephemerally and the bytes do not outlive the request.
// - Logs include only per-modality non-zero counts, the leading 16 hex
//   chars of the commitment, validate-features outcome category, and proof
//   generation diagnostics (path/proof byte length). Never feature values,
//   never fingerprint bits, never salt values.

import { useRouter } from "expo-router";
import { useEffect, useReducer } from "react";
import { StyleSheet, View } from "react-native";

import { ProcessingStage } from "@/components/pulse/ProcessingStage";
import { Screen } from "@/components/primitives/Screen";
import { extractFeatures, MIN_AUDIO_SAMPLES } from "@/extraction";
import { initialContext, reduce, stageCopy } from "@/flows/verifyMachine";
import { bigintToBytes32, generateTBH, simhash } from "@/hashing";
import type { TBH } from "@/hashing";
import { loadBaseline, storeBaseline, wipeBaseline } from "@/identity/baseline";
import { devWarn } from "@/lib/log";
import { generateSolanaProof } from "@/proof/prover";
import { parseSubmitError, type ParsedSubmitError } from "@/protocol/errors";
import type { SignedReceiptDto } from "@/protocol/receipt";
import { submitReset, submitVerify } from "@/protocol/submit";
import { encodeAudioAsBase64 } from "@/sensor/encode";
import { validateFeatures, ValidateOutcome, ValidateReason } from "@/services/executor";
import { useAppState } from "@/state/AppState";
import { clearCapture, takeCapture } from "@/state/captureBuffer";
import { clearChallenge, takeChallenge } from "@/state/challengeBuffer";
import { clearCommitment, setCommitment, takeCommitment } from "@/state/commitmentBuffer";
import { clearProof, setProof, takeProof } from "@/state/proofBuffer";
import { FailureBucket } from "@/state/types";
import { SecureKeys, setSecure } from "@/storage/secure";
import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

export default function Processing() {
  const router = useRouter();
  const { palette } = useTheme();
  const { connection, dev, flow, verify, resetComplete, fail, setForceOutcome, setFlowIntent } =
    useAppState();
  const [ctx, dispatch] = useReducer(reduce, { ...initialContext, state: "extracting" });

  useEffect(() => {
    let cancelled = false;

    // Snapshot wallet credentials at mount-time. /verify/intro already
    // gates on this, but a parallel disconnect (wallet menu) would
    // otherwise surface a confusing on-chain rejection later. We need
    // all three (address, kind, authToken) for MWA's signAndSendTransaction.
    const walletId = connection.address;
    const walletKind = connection.wallet;
    const authToken = connection.authToken;
    if (!walletId || !walletKind || !authToken) {
      router.replace("/connect");
      return;
    }
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

    // Soft-rejects don't count against the verification history (matches
    // the web flow's soft_failed transition) — they're transient retries
    // surfaced through a friendlier UX. Hard buckets above use `failOut`
    // which DOES log to history.
    const routeSoftReject = (reason: ValidateReason) => {
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
        case "service-down":
          devWarn(`[Entros] /validate-features service-down: ${outcome.message}`);
          failOut("relayer-down");
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

    // Real extraction → real Stage 3 (SimHash + Poseidon) → real Stage 4
    // (validate-features) → real Stage 5 (encrypted baseline) → real Stage 6
    // (Groth16 proof, re-verify only) → real Stage 7 (on-chain submit via MWA).
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

        const result = await extractFeatures(captured);

        // Encode audio for /validate-features BEFORE dropping the captured
        // ref so the Float32Array doesn't have to outlive its single use.
        // After this line the only retained audio is the b64 string, which
        // crosses the network.
        const audioSamplesB64 = encodeAudioAsBase64(captured.audio.pcm);
        const audioSampleRateHz = captured.audio.sampleRate;
        // Drop the closure ref to the raw sensor buffers — the four largest
        // typed arrays (~768KB audio + motion + touch) become GC-eligible
        // immediately instead of living until the simulated stages finish.
        captured = null;

        const audioNZ = result.raw.slice(0, 44).filter((v) => v !== 0).length;
        const motionNZ = result.raw.slice(44, 98).filter((v) => v !== 0).length;
        const touchNZ = result.raw.slice(98, 134).filter((v) => v !== 0).length;
        // Diagnostic — counts and lengths, never values. Dev-only.
        devWarn(
          `[Entros] features=${result.raw.length} nz=${audioNZ}/${motionNZ}/${touchNZ} f0Frames=${result.f0Contour.length} accelFrames=${result.accelMagnitude.length}`,
        );

        // Load the previous baseline BEFORE the IIFE so the disk I/O
        // happens before Stage 3 hashing. Skipped for reset cycles —
        // submitReset takes only the new commitment, no ft_prev needed.
        // First verifies also return null and we skip Stage 6 proof
        // generation; mint_anchor takes no proof either.
        const previousBaseline = flowIntent === "reset" ? null : await loadBaseline();
        if (cancelled) return;

        // Stages 3 + 4 + 5 + 6 IIFE. The 256-bit fingerprint AND the
        // previously-stored baseline fingerprint live only inside this
        // scope; they fall out of scope as soon as the IIFE returns. Only
        // the 16-char commitment hex prefix and the validate outcome
        // (signed receipt + remaining quota) escape for logging + Stage 7.
        //
        // Order is simhash + Poseidon → /validate-features → baseline
        // persistence → Groth16 proof, mirroring pulse-sdk pulse.ts:148-291
        // (master-list #146 Phase 4). The commitment must be computed before
        // validation so it can be transmitted as `commitment_new_hex` for
        // the validator to sign. Cost of hashing a payload that ends up
        // rejected: ~20 ms — invisible on the 2-5 s validate round-trip.
        type StagesResult =
          | {
              kind: "ok";
              commitmentHexPrefix: string;
              remainingQuota: number | null;
              signedReceipt: SignedReceiptDto | null;
              firstVerify: boolean;
            }
          | { kind: "fail"; outcome: Exclude<ValidateOutcome, { kind: "ok" }> }
          | { kind: "cancelled" };
        const stagesResult: StagesResult = await (async (): Promise<StagesResult> => {
          // Stage 3: SimHash + Poseidon TBH.
          const fingerprint = simhash(result.normalized);
          const tbh = await generateTBH(fingerprint);
          const commitmentNewHex = Array.from(tbh.commitmentBytes)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");

          // Stage 4: server-side validation. Advance to "validating" before
          // the POST so the UI shows the validating copy while the network
          // round-trip resolves (typically 2-5 s under Whisper inference,
          // up to the 15 s executor.ts timeout). Sends commitment_new_hex
          // so the validator can sign a (wallet, commitment, validated_at)
          // receipt and return it on the ok outcome for first-verify
          // Ed25519 binding.
          if (cancelled) return { kind: "cancelled" };
          dispatch({ type: "advance" });

          const outcome = await validateFeatures({
            features: result.raw,
            walletId,
            f0Contour: result.f0Contour,
            accelMagnitude: result.accelMagnitude,
            audioSamplesB64,
            audioSampleRateHz,
            commitmentNewHex,
          });
          if (cancelled) return { kind: "cancelled" };
          if (outcome.kind !== "ok") return { kind: "fail", outcome };

          // Advance to "computing" before Stage 5 + 6 work fires so the UI
          // shows the "Generating ZK proof" copy while AES-GCM + arkworks
          // proof generation run.
          dispatch({ type: "advance" });

          // Stage 5: encrypted baseline persistence. setCommitment populates
          // the handoff buffer Stage 7 reads from; storeBaseline writes the
          // AES-GCM envelope to expo-secure-store.
          setCommitment({
            commitment: tbh.commitment,
            salt: tbh.salt,
            commitmentBytes: tbh.commitmentBytes,
          });
          try {
            // Pass `tbh.fingerprint` (same number[] as `fingerprint`) to
            // match pulse-sdk/pulse.ts:458 byte-for-byte. The plaintext shape
            // serialised here MUST stay identical to the web SDK so a future
            // migration tool could read either platform's envelope.
            await storeBaseline({
              fingerprint: tbh.fingerprint,
              salt: tbh.salt.toString(),
              commitment: tbh.commitment.toString(),
              timestamp: Date.now(),
            });
          } catch (err) {
            // Persistence failure does NOT abort the current verify cycle
            // — the commitment in commitmentBuffer is still valid for the
            // downstream submit. Only re-verification on a future session
            // depends on the baseline being on disk; the user will be
            // treated as first-time again next session if this fails.
            const message = err instanceof Error ? err.message : String(err);
            devWarn(`[Entros] storeBaseline failed: ${message}`);
          }

          // Stage 6: Groth16 proof on-device. Re-verify only — first-verify
          // skips because mint_anchor takes no proof.
          if (previousBaseline) {
            const previousCommitment = BigInt(previousBaseline.commitment);
            const previousTbh: TBH = {
              fingerprint: previousBaseline.fingerprint,
              salt: BigInt(previousBaseline.salt),
              commitment: previousCommitment,
              commitmentBytes: bigintToBytes32(previousCommitment),
            };
            const proofStartedAt = Date.now();
            const solanaProof = await generateSolanaProof(tbh, previousTbh);
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
            firstVerify: !previousBaseline,
          };
        })();
        if (stagesResult.kind === "cancelled" || cancelled) return;

        if (stagesResult.kind === "fail") {
          routeFromValidateOutcome(stagesResult.outcome);
          return;
        }

        const { commitmentHexPrefix, remainingQuota, signedReceipt, firstVerify } = stagesResult;
        devWarn(`[Entros] /validate-features ok q=${remainingQuota ?? "?"}`);
        // Diagnostic — first 8 bytes (16 hex chars) only. Never the full
        // 32-byte commitment, never the fingerprint bits, never the salt.
        // The receipt is logged only as "present" / "absent" so the dev
        // can see Phase 4 wiring is live without leaking validator-signed
        // bytes (public protocol artefacts, but log noise either way).
        devWarn(
          `[Entros] commitment=${commitmentHexPrefix}… intent=${flowIntent} firstVerify=${firstVerify} receipt=${signedReceipt ? "present" : "absent"}`,
        );

        // Dev panel override fires before any on-chain work — lets UI
        // testers skip the wallet round-trip. Real path falls through.
        if (handleDevOverride()) return;

        // Stage 7: on-chain submission via MWA. Take the buffered slots
        // — none survives past this point.
        const commitmentBuf = takeCommitment();
        const proofBuf = takeProof();
        const challengeBuf = takeChallenge();
        if (!commitmentBuf) {
          // Programming error — Stage 3 IIFE always populates this slot.
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
                authToken,
                walletKind,
                commitment: commitmentBuf.commitmentBytes,
              },
              () => dispatch({ type: "advance" }), // → "submitting" once signed
            );
          } else {
            const nonce = challengeBuf?.nonce ? Array.from(challengeBuf.nonce) : undefined;
            result = await submitVerify(
              {
                walletAddress: walletId,
                authToken,
                walletKind,
                commitment: commitmentBuf.commitmentBytes,
                isFirstVerify: firstVerify,
                proof: proofBuf ?? undefined,
                nonce,
                // First-verify only — submit.ts ignores it on the re-verify
                // branch. Receipt is the validator's Ed25519-signed binding
                // to (wallet, commitment, validated_at) per master-list #146
                // Phase 4. `null` falls back to no-receipt mint (Phase 3
                // log-only OK).
                signedReceipt: signedReceipt ?? undefined,
              },
              () => dispatch({ type: "advance" }), // → "submitting" once signed
            );
          }
          if (cancelled) return;

          // Persist the rotated MWA auth token so the next session signs
          // without prompting for re-authorisation. Token-persist failure
          // must NOT abort the success path — the on-chain tx already
          // confirmed; the worst case is the next session re-prompts the
          // wallet for authorisation.
          try {
            await setSecure(SecureKeys.WALLET_AUTH_TOKEN, result.authToken);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            devWarn(`[Entros] auth_token persist failed: ${message}`);
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

          // Local-state cleanup BEFORE the failure UI routes. Stage 5
          // writes the new baseline INSIDE the IIFE (matching pulse-sdk
          // for byte-identical envelope shape), which is correct for the
          // happy path but leaves orphaned local state on submit failure:
          //  (a) first-verify failure → no on-chain anchor exists yet, but
          //      a baseline envelope is on disk. Next retry would loadBaseline
          //      → previousBaseline non-null → firstVerify=false → try
          //      update_anchor against a non-existent IdentityState PDA →
          //      AccountNotInitialized. Wipe the orphan so retry restarts
          //      cleanly as first-verify. Exception: anchor-already-exists
          //      (Path A repeat for an already-anchored wallet) — DON'T wipe;
          //      route to baseline-missing bucket so the user resets via
          //      reset_identity_state instead.
          //  (b) re-verify failure → baseline was overwritten with the new
          //      fingerprint inside the IIFE, but the on-chain commitment
          //      didn't update. Next retry would generate a proof binding
          //      to the just-written commitment, which differs from the
          //      on-chain current_commitment → PrevCommitmentMismatch.
          //      Restore the previousBaseline envelope so subsequent retries
          //      bind their proof to the on-chain truth.
          // Reset-path failures aren't cleaned up here — the reset cycle
          // works without a previous baseline and a partial overwrite is
          // recoverable on the next reset attempt.
          if (flowIntent !== "reset") {
            try {
              if (firstVerify) {
                if (parsed.kind !== "anchor-already-exists") {
                  await wipeBaseline();
                }
              } else if (previousBaseline) {
                await storeBaseline(previousBaseline);
              }
            } catch (cleanupErr) {
              const cleanupMsg =
                cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
              devWarn(`[Entros] post-failure baseline cleanup failed: ${cleanupMsg}`);
            }
          }

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
