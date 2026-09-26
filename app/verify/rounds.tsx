// Paired-round capture screen: three rounds of one word and one short path.
//
// The server reveals each round only after it accepts the previous one. A
// round advances on its own once the tracker hears the word and the trace has
// reached every point in order. Nothing on this screen counts down or asks the
// person to hurry. A small Continue action appears only when a round has
// stalled with a trace that passes.
//
// PRIVACY CONTRACT:
// - Audio, motion and touch stay in memory. Each round sends digests only.
//   The committed segments leave the device only in the finalize request the
//   processing screen sends. Raw motion and raw touch never leave.
// - No raw sensor value is logged or persisted.
// - On unmount every recorder stops and buffered samples are dropped.

import { randomBytes } from "@noble/hashes/utils.js";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";

import { SensorBars } from "@/components/pulse/SensorBars";
import { WaypointCanvas, type WaypointSample } from "@/components/pulse/WaypointCanvas";
import { Button } from "@/components/primitives/Button";
import { PrivacyPill } from "@/components/primitives/PrivacyPill";
import { Screen } from "@/components/primitives/Screen";
import { SectionLabel } from "@/components/primitives/SectionLabel";
import { Spinner } from "@/components/primitives/Spinner";
import { Text } from "@/components/primitives/Text";
import { pairedFailureScreen } from "@/flows/pairedFailure";
import {
  createPairedSession,
  type CompletedPairedRounds,
  type PairedPhase,
  type PairedRoundView,
  type PairedSessionController,
} from "@/flows/pairedSession";
import { holdSingleCaptureChallenge } from "@/flows/singleCaptureChallenge";
import { advanceReached, PAIRED_PROJECTION_VERSION, toGridPoint } from "@/paired";
import { audioPermissionGranted, requestAudioPermission } from "@/sensor/audio";
import { startContinuousRecording } from "@/sensor/continuousAudio";
import { MotionRecorder, startMotionRecording } from "@/sensor/motion";
import { startTouchRecording, TouchRecorder } from "@/sensor/touch";
import type { PairedFailure } from "@/services/pairedErrors";
import { commitPairedRound, openPairedSession } from "@/services/pairedExecutor";
import { useAppState } from "@/state/AppState";
import { setPairedSession } from "@/state/pairedSessionBuffer";
import { fontFamily, fontSize, spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

const MAX_CANVAS_SIZE = 320;

export default function VerifyRounds() {
  const router = useRouter();
  const { palette } = useTheme();
  const { connection, fail, setForceOutcome } = useAppState();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  // Square, and small enough on a short screen to leave room for the word and
  // the meters.
  const canvasSize = Math.min(
    MAX_CANVAS_SIZE,
    Math.round(windowWidth - spacing.xxl * 2),
    Math.round(windowHeight * 0.4),
  );

  const [phase, setPhase] = useState<PairedPhase>("opening");
  const [round, setRound] = useState<PairedRoundView | null>(null);
  /** Waypoints the trace has reached in order, counted from the first. */
  const [reached, setReached] = useState(0);
  const [canContinue, setCanContinue] = useState(false);

  // Live sensor levels live in mutable refs so they never trigger renders.
  // SensorBars samples them on its own ticker.
  const voiceLevel = useRef(0);
  const motionLevel = useRef(0);
  const touchLevel = useRef(0);
  const sensorLevels = useMemo(
    () => ({ voice: voiceLevel, motion: motionLevel, touch: touchLevel }),
    [],
  );

  const mountedRef = useRef(true);
  const sessionRef = useRef<PairedSessionController | null>(null);
  const motionRef = useRef<MotionRecorder | null>(null);
  const touchRef = useRef<TouchRecorder | null>(null);
  const roundRef = useRef<PairedRoundView | null>(null);
  const startedAtRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    const walletId = connection.address;
    if (!walletId) {
      router.replace("/connect");
      return;
    }
    let settled = false;

    const stopSensors = async (keep: boolean) => {
      const motion = motionRef.current;
      const touch = touchRef.current;
      motionRef.current = null;
      touchRef.current = null;
      if (!keep) {
        await motion?.cancel();
        touch?.cancel();
        return null;
      }
      const motionCapture = motion ? await motion.stop() : null;
      const touchCapture = touch ? touch.stop() : null;
      return motionCapture && touchCapture ? { motion: motionCapture, touch: touchCapture } : null;
    };

    const showFailure = (failure: PairedFailure) => {
      if (!mountedRef.current) return;
      const screen = pairedFailureScreen(failure);
      if (screen.record) fail(screen.record);
      setForceOutcome(null);
      router.replace({ pathname: "/verify/failure", params: screen.params });
    };

    const routeFailure = (failure: PairedFailure) => {
      if (settled) return;
      settled = true;
      void stopSensors(false);
      showFailure(failure);
    };

    // The relayer offers no paired sessions, so this wallet verifies with the
    // single capture instead.
    const fallBackToSingleCapture = async () => {
      if (settled) return;
      settled = true;
      // The capture screen opens its own recording, so this one must be closed first.
      await Promise.all([sessionRef.current?.abort(), stopSensors(false)]);
      if (!mountedRef.current) return;
      try {
        await holdSingleCaptureChallenge(walletId, PAIRED_PROJECTION_VERSION);
      } catch {
        showFailure({ reason: "validation_unavailable" });
        return;
      }
      if (mountedRef.current) router.replace("/verify/capture");
    };

    const finish = async (rounds: CompletedPairedRounds) => {
      if (settled) return;
      let sensors;
      try {
        sensors = await stopSensors(true);
      } catch (error) {
        routeFailure({ detail: error instanceof Error ? error.message : "sensor_capture_failed" });
        return;
      }
      if (!sensors) {
        routeFailure({ detail: "sensor_capture_incomplete" });
        return;
      }
      settled = true;
      if (!mountedRef.current) return;
      // Hand the session to the processing screen. The buffer holds it for one
      // read and clears.
      setPairedSession({ rounds, motion: sensors.motion, touch: sensors.touch });
      router.replace("/verify/processing");
    };

    const session = createPairedSession(
      {
        startRecorder: (onFrame, onFailure) => startContinuousRecording({ onFrame, onFailure }),
        open: (wallet, signal) => openPairedSession(wallet, { signal }),
        commit: (commit, deadlineMs, signal) => commitPairedRound(commit, deadlineMs, { signal }),
        now: () => performance.now(),
        randomBytes,
        defer: (task) => {
          setTimeout(task, 0);
        },
        setTimer: (task, delayMs) => {
          const timer = setTimeout(task, delayMs);
          return () => clearTimeout(timer);
        },
      },
      {
        reveal: (view) => {
          roundRef.current = view;
          if (!mountedRef.current) return;
          setRound(view);
          setReached(0);
        },
        phase: (next) => {
          if (mountedRef.current) setPhase(next);
        },
        continueAvailable: (available) => {
          if (mountedRef.current) setCanContinue(available);
        },
        level: (rms) => {
          voiceLevel.current = Math.max(0, Math.min(1, rms * 4));
        },
        failure: routeFailure,
        unavailable: () => {
          void fallBackToSingleCapture();
        },
        complete: (rounds) => {
          void finish(rounds);
        },
      },
    );
    sessionRef.current = session;

    void (async () => {
      try {
        // A returning user can reach this screen without the onboarding
        // prompt, and the recorder fails without the permission.
        const granted = (await audioPermissionGranted()) || (await requestAudioPermission());
        if (!granted) {
          throw new Error(
            "Microphone access is required to verify. Grant it in System Settings → Apps → Entros → Permissions, then try again.",
          );
        }
        startedAtRef.current = Date.now();
        const motion = await startMotionRecording((magnitude) => {
          // Magnitude is dominated by gravity (~9.8 m/s²); the variation
          // around it is what the bars show.
          motionLevel.current = Math.max(0, Math.min(1, (magnitude - 9.0) / 4));
        });
        if (!mountedRef.current || settled) {
          await motion.cancel();
          return;
        }
        motionRef.current = motion;
        touchRef.current = startTouchRecording((velocity) => {
          touchLevel.current = Math.max(0, Math.min(1, velocity * 1.4));
        }, PAIRED_PROJECTION_VERSION);
        await session.start(walletId);
      } catch (error) {
        routeFailure({
          detail: error instanceof Error ? error.message : "Could not start sensors.",
        });
      }
    })();

    return () => {
      mountedRef.current = false;
      void session.abort();
      void stopSensors(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Samples arrive on the JS thread from the gesture worklet.
  const handleSample = useCallback(
    (sample: WaypointSample) => {
      const size = canvasSize;
      const surface = { width: size, height: size };
      touchRef.current?.push({
        t: sample.t - startedAtRef.current,
        x: Math.max(0, Math.min(1, sample.x / size)),
        y: Math.max(0, Math.min(1, sample.y / size)),
        pressure: 1,
      });
      sessionRef.current?.trace(sample, surface);

      const view = roundRef.current;
      if (!view) return;
      // The same in-order rule the tracker applies, so a dot lights only once
      // every dot before it has.
      const point = toGridPoint(sample.x, sample.y, surface);
      setReached((previous) => advanceReached(view.waypoints, previous, point));
    },
    [canvasSize],
  );

  const lastRound = round !== null && round.roundIndex >= round.rounds;
  const caption =
    phase === "committing"
      ? lastRound
        ? "Finishing"
        : "Next round"
      : canContinue
        ? "Say the word and trace through every point in order. If you already did, continue."
        : "Say the word and trace through the points in order. The next round starts on its own.";

  return (
    <Screen padded={false}>
      <View style={styles.wrap}>
        {round === null ? (
          <View style={styles.center}>
            <Spinner size={36} />
            <Text variant="body" tone="muted" align="center">
              Opening a session
            </Text>
          </View>
        ) : (
          <View style={styles.middle}>
            <View style={styles.wordBlock}>
              <SectionLabel>{`ROUND ${round.roundIndex} OF ${round.rounds}`}</SectionLabel>
              <Text
                accessibilityLiveRegion="polite"
                style={[
                  styles.word,
                  {
                    color: palette.text,
                    fontFamily: fontFamily.bold,
                    opacity: phase === "round" ? 1 : 0.45,
                  },
                ]}
              >
                {round.word}
              </Text>
            </View>
            <WaypointCanvas
              size={canvasSize}
              waypoints={round.waypoints}
              reached={reached}
              active={phase === "round"}
              strokeKey={round.roundIndex}
              onSample={handleSample}
            />
            <View style={styles.guidance}>
              <Text variant="caption" tone="muted" align="center">
                {caption}
              </Text>
              {canContinue && phase === "round" ? (
                <Button
                  label="Continue"
                  variant="ghost"
                  size="sm"
                  onPress={() => {
                    sessionRef.current?.continueRound();
                  }}
                />
              ) : null}
            </View>
            <View style={styles.sensorBlock}>
              <SensorBars active levels={sensorLevels} />
            </View>
          </View>
        )}
        <View style={styles.bottom}>
          <PrivacyPill />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xxl,
    paddingBottom: spacing.xl,
    gap: spacing.xl,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.lg },
  middle: {
    flex: 1,
    justifyContent: "space-around",
    alignItems: "center",
    gap: spacing.lg,
  },
  wordBlock: { gap: spacing.md, alignItems: "center" },
  word: {
    fontSize: fontSize.display,
    lineHeight: fontSize.display * 1.2,
    textAlign: "center",
  },
  guidance: { alignItems: "center", gap: spacing.sm, minHeight: 72 },
  sensorBlock: { width: "100%", alignItems: "center" },
  bottom: { alignItems: "center" },
});
