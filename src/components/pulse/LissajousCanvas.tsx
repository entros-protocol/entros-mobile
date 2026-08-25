import { useEffect, useMemo } from "react";
import { LayoutChangeEvent, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";

import { generateLissajousPoints, type LissajousParams } from "@/challenge/lissajous";
import { getProjectionDefinition } from "@/projection";
import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

import { SectionLabel } from "../primitives/SectionLabel";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export interface NormalizedTouchPoint {
  /** Timestamp in milliseconds since canvas mount. */
  t: number;
  /** Coordinates in [0, 1] relative to the canvas. */
  x: number;
  y: number;
  pressure: number;
  curveX: number;
  curveY: number;
}

interface LissajousCanvasProps {
  params: LissajousParams;
  projectionVersion: number;
  width?: number;
  height?: number;
  active?: boolean;
  durationMs?: number;
  /**
   * When provided, the canvas wraps in a PanGesture and forwards bounded
   * touch samples (normalised to [0, 1]) to the caller for recording.
   * Without it the canvas runs an auto-replay preview.
   */
  onTouchPoint?: (point: NormalizedTouchPoint) => void;
  onContactStart?: () => void;
  onContactEnd?: () => void;
  onTouchFailure?: (message: string) => void;
}

const buildPath = (points: { x: number; y: number }[], w: number, h: number): string => {
  return points
    .map(({ x, y }, i) => {
      const px = (x / 200) * w;
      const py = (y / 200) * h;
      return `${i === 0 ? "M" : "L"}${px.toFixed(2)} ${py.toFixed(2)}`;
    })
    .join(" ");
};

export const LissajousCanvas = ({
  params,
  projectionVersion,
  width = 280,
  height = 180,
  active = true,
  durationMs = 12_000,
  onTouchPoint,
  onContactStart,
  onContactEnd,
  onTouchFailure,
}: LissajousCanvasProps) => {
  const { palette } = useTheme();
  const points = useMemo(() => generateLissajousPoints(params), [params]);
  const fullPath = useMemo(() => buildPath(points, width, height), [points, width, height]);
  const isInteractive = typeof onTouchPoint === "function";

  // Geometry constants (UI-thread-safe primitives).
  const cxBase = width / 2;
  const cyBase = height / 2;
  const a = params.a;
  const b = params.b;
  const delta = params.delta;
  const anchorX = params.anchorX;
  const anchorY = params.anchorY;
  const normalizedTouch =
    getProjectionDefinition(projectionVersion).featurePipeline === "normalized-touch";

  // Auto-replay progress driver (used only when not interactive).
  const traceProgress = useSharedValue(0);
  const traceLength = points.length;
  const dashTotal = useMemo(() => traceLength * 6, [traceLength]);

  useEffect(() => {
    traceProgress.value = 0;
    if (!active || isInteractive) return;
    traceProgress.value = withTiming(1, {
      duration: durationMs,
      easing: Easing.linear,
    });
  }, [active, durationMs, traceProgress, isInteractive]);

  const tracedPathProps = useAnimatedProps(() => ({
    strokeDasharray: [dashTotal * traceProgress.value, dashTotal],
  }));

  const replayCursorProps = useAnimatedProps(() => {
    const t = traceProgress.value * Math.PI * 2;
    const x = Math.sin(a * t + delta);
    const y = Math.sin(b * t);
    return {
      cx: (((x + 1) / 2) * 100 + anchorX) * (width / 200),
      cy: (((y + 1) / 2) * 100 + anchorY) * (height / 200),
    };
  });

  // Live cursor position — driven directly by the gesture worklet on the UI
  // thread, so finger tracking does not trigger React re-renders.
  const liveCursorX = useSharedValue(cxBase);
  const liveCursorY = useSharedValue(cyBase);
  const startedAtMs = useSharedValue<number>(0);
  const lastBridgeAtMs = useSharedValue<number>(-Infinity);
  const contactStarted = useSharedValue(false);

  const liveCursorProps = useAnimatedProps(() => ({
    cx: liveCursorX.value,
    cy: liveCursorY.value,
  }));

  // The gesture callback is a worklet running on the UI thread. It updates
  // the sharedValues directly (zero React work), then bridges bounded samples
  // to the JS recorder.
  const dispatchTouch = (t: number, x: number, y: number) => {
    onTouchPoint?.({ t, x, y, pressure: 1, curveX: x * 200, curveY: y * 200 });
  };
  const dispatchContactStart = () => onContactStart?.();
  const dispatchContactEnd = () => onContactEnd?.();
  const dispatchFailure = (message: string) => onTouchFailure?.(message);

  const pan = Gesture.Pan()
    .minDistance(0)
    .onTouchesDown((event) => {
      "worklet";
      const touch = event.allTouches[0];
      if (!touch) return;
      if (normalizedTouch && (event.allTouches.length !== 1 || contactStarted.value)) {
        runOnJS(dispatchFailure)("Normalized touch capture requires one continuous contact");
        return;
      }
      const now = normalizedTouch ? performance.now() : Date.now();
      if (normalizedTouch) {
        contactStarted.value = true;
        startedAtMs.value = now;
        runOnJS(dispatchContactStart)();
      }
      const rawX = touch.x / width;
      const rawY = touch.y / height;
      if (normalizedTouch && (rawX < 0 || rawX > 1 || rawY < 0 || rawY > 1)) {
        runOnJS(dispatchFailure)("Normalized touch coordinates must stay inside the unit surface");
        return;
      }
      const nx = normalizedTouch ? rawX : Math.max(0, Math.min(1, rawX));
      const ny = normalizedTouch ? rawY : Math.max(0, Math.min(1, rawY));
      liveCursorX.value = normalizedTouch ? touch.x : cxBase + (nx * 2 - 1) * (width / 2 - 14);
      liveCursorY.value = normalizedTouch ? touch.y : cyBase + (ny * 2 - 1) * (height / 2 - 14);
      const tMs = now - startedAtMs.value;
      lastBridgeAtMs.value = now;
      runOnJS(dispatchTouch)(tMs, nx, ny);
    })
    .onTouchesMove((event) => {
      "worklet";
      const touch = event.allTouches[0];
      if (!touch) return;
      if (normalizedTouch && event.allTouches.length !== 1) {
        runOnJS(dispatchFailure)("Normalized touch capture requires one continuous contact");
        return;
      }
      const now = normalizedTouch ? performance.now() : Date.now();
      if (normalizedTouch && now - lastBridgeAtMs.value < 1_000 / 240) return;
      const rawX = touch.x / width;
      const rawY = touch.y / height;
      if (normalizedTouch && (rawX < 0 || rawX > 1 || rawY < 0 || rawY > 1)) {
        runOnJS(dispatchFailure)("Normalized touch coordinates must stay inside the unit surface");
        return;
      }
      const nx = normalizedTouch ? rawX : Math.max(0, Math.min(1, rawX));
      const ny = normalizedTouch ? rawY : Math.max(0, Math.min(1, rawY));
      liveCursorX.value = normalizedTouch ? touch.x : cxBase + (nx * 2 - 1) * (width / 2 - 14);
      liveCursorY.value = normalizedTouch ? touch.y : cyBase + (ny * 2 - 1) * (height / 2 - 14);
      const tMs = startedAtMs.value > 0 ? now - startedAtMs.value : 0;
      lastBridgeAtMs.value = now;
      runOnJS(dispatchTouch)(tMs, nx, ny);
    })
    .onTouchesUp((event) => {
      "worklet";
      if (event.allTouches.length === 0 && contactStarted.value) {
        runOnJS(dispatchContactEnd)();
      }
    })
    .onTouchesCancelled(() => {
      "worklet";
      if (normalizedTouch) {
        runOnJS(dispatchFailure)("Normalized touch capture was interrupted");
      }
    });

  const onLayout = (_: LayoutChangeEvent) => {
    if (!normalizedTouch && startedAtMs.value === 0) startedAtMs.value = Date.now();
  };

  const Canvas = (
    <View
      onLayout={onLayout}
      style={[
        styles.canvas,
        {
          width,
          height,
          backgroundColor: palette.surface,
          borderColor: palette.border,
        },
      ]}
    >
      <Svg width={width} height={height}>
        <Path
          d={fullPath}
          stroke={palette.solanaGreen}
          strokeWidth={2}
          strokeLinecap="round"
          fill="transparent"
          opacity={0.18}
        />
        {isInteractive ? null : (
          <AnimatedPath
            d={fullPath}
            stroke={palette.solanaGreen}
            strokeWidth={2.4}
            strokeLinecap="round"
            fill="transparent"
            animatedProps={tracedPathProps}
          />
        )}
        <AnimatedCircle
          r={5}
          fill={palette.solanaGreen}
          stroke={palette.background}
          strokeWidth={2}
          animatedProps={isInteractive ? liveCursorProps : replayCursorProps}
        />
      </Svg>
    </View>
  );

  return (
    <View style={styles.wrap}>
      <SectionLabel tone="accent">TRACE</SectionLabel>
      {isInteractive ? <GestureDetector gesture={pan}>{Canvas}</GestureDetector> : Canvas}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    gap: spacing.md,
    alignItems: "center",
  },
  canvas: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: "hidden",
  },
});
