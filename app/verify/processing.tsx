// Verification processing screen.
//
// Stages 1–5 are real:
// - Stage 1 (sensor capture) runs in /verify/capture and lands in the buffer.
// - Stage 2 (134-feature extraction) runs in the `extracting` step here.
// - Stage 4 (server-side validation) POSTs the 134-feature vector + cross-
//   modal time-series + audio b64 to the executor's /validate-features
//   endpoint, surfacing soft-rejects with a friendly retry UX and routing
//   service / rate-limit errors to the appropriate failure bucket. Runs
//   BEFORE Stage 3 hashing so a rejected verification doesn't waste cycles
//   computing a commitment that won't be submitted.
// - Stage 3 (SimHash + Poseidon TBH) runs after validate-success, producing
//   the 32-byte commitment that forward stages submit.
// - Stage 5 (encrypted baseline persistence) encrypts the
//   {fingerprint, salt, commitment, timestamp} bundle with AES-256-GCM
//   inside the same IIFE as Stage 3 so the fingerprint never escapes its
//   tight scope. Ciphertext lives in expo-secure-store under
//   `entros.v1.baseline.envelope`; the AES key under `entros.v1.baseline.key`.
// Stages 6–7 (ZK proof, on-chain submit) remain simulated `setTimeout`
// waits and land in subsequent commits.
//
// PRIVACY:
// - Captured SensorData is taken once from the buffer and dropped the moment
//   extractFeatures() returns + the audio is base64-encoded for /validate-
//   features. After that the typed arrays are GC-eligible immediately
//   instead of living until the simulated stages finish.
// - The 256-bit fingerprint is held only inside the Stages 3+5 IIFE
//   (simhash → generateTBH → storeBaseline). After the IIFE closes, only
//   the AES ciphertext envelope on disk and the commitment + salt in the
//   handoff buffer survive — no plaintext fingerprint anywhere.
// - Audio b64 is the single sanctioned exception (paper §6.8 +
//   src/sensor/types.ts:7-8). The validation service runs Whisper-tiny on
//   it ephemerally and the bytes do not outlive the request.
// - Logs include only per-modality non-zero counts, the leading 16 hex
//   chars of the commitment, and validate-features outcome category.
//   Never feature values, never fingerprint bits, never salt values.

import { useRouter } from "expo-router";
import { useEffect, useReducer, useRef } from "react";
import { StyleSheet, View } from "react-native";

import { ProcessingStage } from "@/components/pulse/ProcessingStage";
import { Screen } from "@/components/primitives/Screen";
import { extractFeatures, MIN_AUDIO_SAMPLES } from "@/extraction";
import {
  initialContext,
  reduce,
  stageCopy,
  stageDurationsMs,
  VerifyState,
} from "@/flows/verifyMachine";
import { generateTBH, simhash } from "@/hashing";
import { storeBaseline } from "@/identity/baseline";
import { devWarn } from "@/lib/log";
import { encodeAudioAsBase64 } from "@/sensor/encode";
import { validateFeatures, ValidateOutcome, ValidateReason } from "@/services/executor";
import { useAppState } from "@/state/AppState";
import { clearCapture, takeCapture } from "@/state/captureBuffer";
import { clearChallenge } from "@/state/challengeBuffer";
import { clearCommitment, setCommitment } from "@/state/commitmentBuffer";
import { FailureBucket } from "@/state/types";
import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

// Stages that still drive the screen via simulated setTimeout waits. Stages
// 1–4 (extracting + validating) are now real and dispatched outside this
// cascade.
const SIMULATED_STAGES: VerifyState[] = ["computing", "signing", "submitting"];

const pickFailureBucket = (): FailureBucket => {
  const r = Math.random();
  if (r < 0.5) return "relayer-down";
  if (r < 0.8) return "baseline-missing";
  return "generic";
};

export default function Processing() {
  const router = useRouter();
  const { palette } = useTheme();
  const { connection, dev, verify, fail, setForceOutcome } = useAppState();
  const [ctx, dispatch] = useReducer(reduce, { ...initialContext, state: "extracting" });
  const stageRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    // Snapshot the wallet pubkey at mount-time. /verify/intro already gates
    // on this, but a parallel disconnect (wallet menu) would otherwise
    // surface a confusing "executor returned 400" later. If null, redirect
    // and bail.
    const walletId = connection.address;
    if (!walletId) {
      router.replace("/connect");
      return;
    }

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

    const runSimulatedStage = (i: number) => {
      if (cancelled) return;
      if (i >= SIMULATED_STAGES.length) {
        const force = dev.forceOutcome;
        const isFailure = force && force !== "success";
        const bucket: FailureBucket | null = isFailure
          ? (force as FailureBucket)
          : force === null && Math.random() < 0.05
            ? pickFailureBucket()
            : null;
        if (bucket) {
          failOut(bucket);
          return;
        }
        const txSig = `${Math.random().toString(36).slice(2, 10)}…rY${Math.floor(Math.random() * 99)}x`;
        verify(2, txSig);
        setForceOutcome(null);
        router.replace("/verify/success");
        return;
      }
      // Bounds-checked above so SIMULATED_STAGES[i] is always defined.
      const stage = SIMULATED_STAGES[i]!;
      dispatch({ type: "advance" });
      stageRef.current = i;
      const duration = stageDurationsMs[stage] ?? 1_000;
      setTimeout(() => runSimulatedStage(i + 1), duration);
    };

    // Real extraction → real Stage 3 (SimHash + Poseidon) → real Stage 4
    // (validate-features) → simulated tail (computing/signing/submitting).
    const runVerify = async () => {
      let captured: ReturnType<typeof takeCapture> = takeCapture();
      if (!captured) {
        // Direct nav (e.g. dev refresh) lands here. Fall back to the
        // simulated tail so the screen still flows; without a capture
        // there's nothing to validate.
        runSimulatedStage(0);
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

        // Stage 4: server-side validation. Advance the state machine into
        // "validating" before the POST so the UI shows the validating copy
        // for the duration of the network round-trip (typically 2–5 s under
        // Whisper inference, up to the 15 s executor.ts timeout).
        //
        // Mirrors pulse-sdk pulse.ts:137-228: validate BEFORE simhash so a
        // rejected verification doesn't waste ~50–100 ms on hashing work.
        if (cancelled) return;
        dispatch({ type: "advance" });

        const outcome = await validateFeatures({
          features: result.raw,
          walletId,
          f0Contour: result.f0Contour,
          accelMagnitude: result.accelMagnitude,
          audioSamplesB64,
          audioSampleRateHz,
        });
        if (cancelled) return;

        if (outcome.kind !== "ok") {
          routeFromValidateOutcome(outcome);
          return;
        }
        devWarn(`[Entros] /validate-features ok q=${outcome.remainingQuota ?? "?"}`);

        // Stage 3 + Stage 5: SimHash → Poseidon commitment → encrypted
        // baseline persistence, wrapped in a single IIFE so the
        // `fingerprint` and `tbh` locals fall out of scope as soon as
        // storeBaseline returns. The fingerprint is the most sensitive
        // value in the verify flow; tightening its lifetime to this
        // 50–100 ms window is the privacy contract for Stages 3 + 5.
        // Only the 16-char hex commitment prefix escapes the IIFE for
        // diagnostic logging.
        const commitmentHexPrefix = await (async (): Promise<string> => {
          const fingerprint = simhash(result.normalized);
          const tbh = await generateTBH(fingerprint);
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
          return Array.from(tbh.commitmentBytes.slice(0, 8))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
        })();
        // Diagnostic — first 8 bytes (16 hex chars) only. Never the full
        // 32-byte commitment, never the fingerprint bits, never the salt.
        devWarn(`[Entros] commitment=${commitmentHexPrefix}…`);
        if (cancelled) return;

        runSimulatedStage(0);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Verification failed.";
        failOut("generic", message);
      }
    };

    void runVerify();
    return () => {
      cancelled = true;
      // Defence-in-depth: clear all three handoff slots if the screen
      // unmounts mid-flow (back nav, app suspend, etc.). The next verify
      // cycle starts from a known-empty state.
      clearCapture();
      clearCommitment();
      clearChallenge();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `Math.min(..., length - 1)` clamps to a valid index, and SIMULATED_STAGES
  // is non-empty, so this is always defined. ctx.state takes precedence
  // anyway — see `display` below — this is just the fallback when ctx.state
  // has no copy entry.
  const currentStage = SIMULATED_STAGES[Math.min(stageRef.current, SIMULATED_STAGES.length - 1)]!;
  const copy = stageCopy[currentStage];
  const stageState = ctx.state;
  const display = stageCopy[stageState] ?? copy;

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
