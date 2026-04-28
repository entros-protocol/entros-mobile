// Verification processing screen.
//
// Stages 1–3 are real:
// - Stage 1 (sensor capture) runs in /verify/capture and lands in the buffer.
// - Stage 2 (134-feature extraction) runs in the `extracting` step here.
// - Stage 3 (SimHash + Poseidon TBH) runs immediately after extraction,
//   producing the 32-byte commitment that forward stages submit.
// Stages 4–7 (validation HTTP, ZK proof, on-chain submit) remain simulated
// `setTimeout` waits and land in subsequent commits.
//
// PRIVACY:
// - Captured SensorData is taken once from the buffer and dropped the moment
//   extractFeatures() returns.
// - The 256-bit fingerprint is consumed by generateTBH() and the local
//   reference is dropped immediately after — only the commitment + salt
//   move forward via commitmentBuffer.
// - Logs include only per-modality non-zero counts and the leading 16 hex
//   chars of the commitment. Never feature values, never fingerprint bits,
//   never salt values.

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
import { devWarn } from "@/lib/log";
import { useAppState } from "@/state/AppState";
import { clearCapture, takeCapture } from "@/state/captureBuffer";
import { clearCommitment, setCommitment } from "@/state/commitmentBuffer";
import { FailureBucket } from "@/state/types";
import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

const PROCESSING_STAGES: VerifyState[] = [
  "extracting",
  "validating",
  "computing",
  "signing",
  "submitting",
];

const pickFailureBucket = (): FailureBucket => {
  const r = Math.random();
  if (r < 0.5) return "relayer-down";
  if (r < 0.8) return "baseline-missing";
  return "generic";
};

export default function Processing() {
  const router = useRouter();
  const { palette } = useTheme();
  const { dev, verify, fail, setForceOutcome } = useAppState();
  const [ctx, dispatch] = useReducer(reduce, { ...initialContext, state: "extracting" });
  const stageRef = useRef(0);

  useEffect(() => {
    let cancelled = false;

    const failOut = (bucket: FailureBucket, message?: string) => {
      if (cancelled) return;
      fail(bucket);
      setForceOutcome(null);
      router.replace({
        pathname: "/verify/failure",
        params: message ? { bucket, message } : { bucket },
      });
    };

    const runStage = (i: number) => {
      if (cancelled) return;
      if (i >= PROCESSING_STAGES.length) {
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
      // Bounds-checked above (`if (i >= PROCESSING_STAGES.length)`), so the
      // index is always valid here.
      const stage = PROCESSING_STAGES[i]!;
      dispatch({ type: "advance" });
      stageRef.current = i;
      const duration = stageDurationsMs[stage] ?? 1_000;
      setTimeout(() => runStage(i + 1), duration);
    };

    // Real extraction up front. The remaining stages are still simulated;
    // they land for real in Stages 3–7.
    const runExtraction = async () => {
      let captured: ReturnType<typeof takeCapture> = takeCapture();
      if (!captured) {
        // Direct nav (e.g. dev refresh) lands here. Fall back to the
        // simulated path so the screen still flows.
        runStage(0);
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

        // Stage 3: SimHash → 256-bit fingerprint → Poseidon commitment.
        // Wrapped in an IIFE so the `fingerprint` and `tbh` locals fall out
        // of scope before `runStage(0)` runs — they exist only for the few
        // ms it takes generateTBH to resolve. Only the 16-char hex prefix
        // survives into the outer closure for the diagnostic log.
        const commitmentHexPrefix = await (async (): Promise<string> => {
          const fingerprint = simhash(result.normalized);
          const tbh = await generateTBH(fingerprint);
          setCommitment({
            commitment: tbh.commitment,
            salt: tbh.salt,
            commitmentBytes: tbh.commitmentBytes,
          });
          return Array.from(tbh.commitmentBytes.slice(0, 8))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
        })();
        // Diagnostic — first 8 bytes (16 hex chars) only. Never the full
        // 32-byte commitment, never the fingerprint bits, never the salt.
        devWarn(`[Entros] commitment=${commitmentHexPrefix}…`);

        runStage(0);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Feature extraction failed.";
        failOut("generic", message);
      }
    };

    void runExtraction();
    return () => {
      cancelled = true;
      // Defence-in-depth: clear both handoff slots if the screen unmounts
      // mid-flow (back nav, app suspend, etc.). The next verify cycle
      // starts from a known-empty state.
      clearCapture();
      clearCommitment();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `Math.min(..., length - 1)` clamps to a valid index, and PROCESSING_STAGES
  // is non-empty, so this is always defined.
  const currentStage = PROCESSING_STAGES[Math.min(stageRef.current, PROCESSING_STAGES.length - 1)]!;
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
