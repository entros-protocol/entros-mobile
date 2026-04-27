// Verification capture screen.
//
// PRIVACY CONTRACT (paper §6.8 + AUDIT.md):
// - Audio PCM, motion samples, and touch coordinates live in memory only
//   for the duration of capture + the brief feature-extraction pass that
//   follows it (Stage 2).
// - Nothing is logged with values, persisted, or transmitted from this
//   screen. Only sample counts and rates appear in dev logs.
// - On suspension or back-navigation, recordings are cancelled and any
//   buffered samples are dropped before the screen unmounts.

import { useRouter } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { ChallengePhrase } from "@/components/pulse/ChallengePhrase";
import { CountdownDisplay } from "@/components/pulse/CountdownDisplay";
import { LissajousCanvas, NormalizedTouchPoint } from "@/components/pulse/LissajousCanvas";
import { SensorBars } from "@/components/pulse/SensorBars";
import { PrivacyPill } from "@/components/primitives/PrivacyPill";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Text } from "@/components/primitives/Text";
import {
  audioPermissionGranted,
  AudioRecorder,
  requestAudioPermission,
  startAudioRecording,
} from "@/sensor/audio";
import { MotionRecorder, startMotionRecording } from "@/sensor/motion";
import { startTouchRecording, TouchRecorder } from "@/sensor/touch";
import { setCapture } from "@/state/captureBuffer";
import { pickLissajous, pickPhrase } from "@/state/mockChallenge";
import { fontFamily, fontSize, radii, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

const COUNTDOWN_MS = 3_000;
const CAPTURE_MS = 12_000;

type Phase = "countdown" | "capturing";

export default function VerifyCapture() {
  const router = useRouter();
  const { palette } = useTheme();
  const phrase = useMemo(() => pickPhrase(), []);
  const params = useMemo(() => pickLissajous(), []);

  const [phase, setPhase] = useState<Phase>("countdown");
  const [countdown, setCountdown] = useState(3);
  const [progress, setProgress] = useState(0);

  // Live sensor levels live in mutable refs — never trigger React renders.
  // SensorBars samples them on its own ticker. The capture screen only
  // re-renders for the timer (50ms) and phase changes.
  const voiceLevel = useRef(0);
  const motionLevel = useRef(0);
  const touchLevel = useRef(0);
  const sensorLevels = useMemo(
    () => ({ voice: voiceLevel, motion: motionLevel, touch: touchLevel }),
    [],
  );

  const startedAtRef = useRef<number | null>(null);
  const audioRef = useRef<AudioRecorder | null>(null);
  const motionRef = useRef<MotionRecorder | null>(null);
  const touchRef = useRef<TouchRecorder | null>(null);
  const mountedRef = useRef(true);
  const completionFiredRef = useRef(false);

  // Countdown loop.
  useEffect(() => {
    if (phase !== "countdown") return;
    if (countdown <= 0) {
      void beginCapture();
      return;
    }
    const id = setTimeout(() => setCountdown((c) => c - 1), COUNTDOWN_MS / 3);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, countdown]);

  // Capture progress + auto-finish.
  useEffect(() => {
    if (phase !== "capturing") return;
    const tick = () => {
      const elapsed = startedAtRef.current ? Date.now() - startedAtRef.current : 0;
      setProgress(Math.min(1, elapsed / CAPTURE_MS));
    };
    const interval = setInterval(tick, 50);
    const finish = setTimeout(() => {
      void completeCapture();
    }, CAPTURE_MS);
    return () => {
      clearInterval(interval);
      clearTimeout(finish);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Cleanup on unmount: cancel any in-flight recordings + drop buffered data.
  // Async cancels fire and forget — acceptable because the recorders' own
  // teardown is synchronous-enough (one native call) and any leftover memory
  // is collected once refs are nulled.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      void audioRef.current?.cancel();
      void motionRef.current?.cancel();
      audioRef.current = null;
      motionRef.current = null;
      touchRef.current = null;
    };
  }, []);

  const beginCapture = async () => {
    try {
      // JIT permission gate. Onboarding asks once but a returning user
      // navigating straight to /verify won't re-trigger it, and the
      // AudioRecord constructor silently fails if RECORD_AUDIO isn't held —
      // surfacing as the cryptic "uninitialized AudioRecord" panic in
      // LogBox. Check + request here as the canonical gate.
      const alreadyGranted = await audioPermissionGranted();
      if (!alreadyGranted) {
        const granted = await requestAudioPermission();
        if (!granted) {
          throw new Error(
            "Microphone access is required to verify. Grant it in System Settings → Apps → Entros → Permissions, then try again.",
          );
        }
      }

      const motion = await startMotionRecording((mag) => {
        if (!mountedRef.current) return;
        // Magnitude is dominated by gravity (~9.8 m/s²); the variation around
        // it is what we want to visualise. Centre on 9.0 and clamp to [0, 1].
        motionLevel.current = Math.max(0, Math.min(1, (mag - 9.0) / 4));
      });
      if (!mountedRef.current) {
        await motion.cancel();
        return;
      }
      motionRef.current = motion;

      const audio = await startAudioRecording((rms) => {
        if (!mountedRef.current) return;
        voiceLevel.current = Math.max(0, Math.min(1, rms));
      });
      if (!mountedRef.current) {
        await audio.cancel();
        await motion.cancel();
        motionRef.current = null;
        return;
      }
      audioRef.current = audio;

      touchRef.current = startTouchRecording((v) => {
        if (!mountedRef.current) return;
        touchLevel.current = Math.max(0, Math.min(1, v * 1.4));
      });

      startedAtRef.current = Date.now();
      setPhase("capturing");
    } catch (err) {
      await audioRef.current?.cancel();
      await motionRef.current?.cancel();
      audioRef.current = null;
      motionRef.current = null;
      touchRef.current = null;
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : "Could not start sensors.";
      router.replace({
        pathname: "/verify/failure",
        params: { bucket: "generic", message },
      });
    }
  };

  const completeCapture = async () => {
    if (completionFiredRef.current) return;
    completionFiredRef.current = true;
    try {
      const audioCapture = audioRef.current ? await audioRef.current.stop() : null;
      const motionCapture = motionRef.current ? await motionRef.current.stop() : null;
      const touchCapture = touchRef.current ? touchRef.current.stop() : null;

      audioRef.current = null;
      motionRef.current = null;
      touchRef.current = null;

      if (!audioCapture || !motionCapture || !touchCapture) {
        if (!mountedRef.current) return;
        router.replace({
          pathname: "/verify/failure",
          params: {
            bucket: "generic",
            message: "Sensor capture incomplete. Please try again.",
          },
        });
        return;
      }

      // Hand the buffer off to the processing screen. The captureBuffer
      // module holds it for one read and clears immediately.
      setCapture({
        audio: audioCapture,
        motion: motionCapture,
        touch: touchCapture,
      });

      if (!mountedRef.current) return;
      router.replace("/verify/processing");
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : "Capture failed.";
      router.replace({
        pathname: "/verify/failure",
        params: { bucket: "generic", message },
      });
    }
  };

  // Touch points arrive on the JS thread via runOnJS from the gesture worklet.
  const handleTouchPoint = (point: NormalizedTouchPoint) => {
    touchRef.current?.push(point);
  };

  return (
    <Screen padded={false}>
      {phase === "countdown" ? (
        <View style={styles.center}>
          <CountdownDisplay value={countdown} />
        </View>
      ) : (
        <View style={styles.captureWrap}>
          <View style={styles.timerBlock}>
            <View style={styles.timerRow}>
              <SectionLabel>CAPTURING</SectionLabel>
              <Text
                style={[
                  styles.timerText,
                  { color: palette.accent, fontFamily: fontFamily.regular },
                ]}
              >
                {Math.max(0, Math.ceil((1 - progress) * 12))}s
              </Text>
            </View>
            <View style={[styles.progressTrack, { backgroundColor: palette.border }]}>
              <View
                style={[
                  styles.progressFill,
                  {
                    backgroundColor: palette.accent,
                    width: `${progress * 100}%`,
                  },
                ]}
              />
            </View>
          </View>

          <View style={styles.middle}>
            <ChallengePhrase phrase={phrase} active />
            <LissajousCanvas
              params={params}
              active
              durationMs={CAPTURE_MS}
              onTouchPoint={handleTouchPoint}
            />
            <View style={styles.sensorBlock}>
              <SectionLabel>SENSORS</SectionLabel>
              <SensorBars active levels={sensorLevels} />
            </View>
          </View>

          <View style={styles.bottom}>
            <PrivacyPill />
          </View>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  captureWrap: {
    flex: 1,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xl,
    gap: spacing.xl,
  },
  timerBlock: { gap: spacing.sm },
  timerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  timerText: {
    fontSize: fontSize.title,
    letterSpacing: -0.5,
  },
  progressTrack: {
    height: 3,
    borderRadius: radii.pill,
    overflow: "hidden",
  },
  progressFill: { height: "100%", borderRadius: radii.pill },
  middle: {
    flex: 1,
    justifyContent: "space-around",
    alignItems: "center",
    gap: spacing.lg,
  },
  sensorBlock: {
    width: "100%",
    gap: spacing.md,
    alignItems: "center",
  },
  bottom: { alignItems: "center" },
});
