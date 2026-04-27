// Verification processing screen.
//
// Stage 2 (this stage) runs the real 134-element feature extraction off
// the sensor buffer set by the capture screen. Stages 3–7 (SimHash,
// validation, ZK proof, on-chain submit) remain simulated for now and
// land in subsequent commits.
//
// PRIVACY: the captured SensorData is taken once from the buffer and
// dropped the moment extractFeatures() returns. Logs include only
// per-modality non-zero counts, never values.

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
import { clearCapture, takeCapture } from "@/state/captureBuffer";
import { useAppState } from "@/state/AppState";
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
        // Diagnostic only — counts and lengths, never values.
        // eslint-disable-next-line no-console
        console.warn(
          `[Entros] features=${result.raw.length} nz=${audioNZ}/${motionNZ}/${touchNZ} f0Frames=${result.f0Contour.length} accelFrames=${result.accelMagnitude.length}`,
        );

        runStage(0);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Feature extraction failed.";
        failOut("generic", message);
      }
    };

    void runExtraction();
    return () => {
      cancelled = true;
      // Defence-in-depth: clear any leftover sensor buffer if the screen
      // unmounts mid-extraction (back nav, app suspend, etc.).
      clearCapture();
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
