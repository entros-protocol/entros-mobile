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

import { spacing } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

import { SectionLabel } from "../primitives/SectionLabel";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export interface LissajousParams {
  a: number;
  b: number;
  delta: number;
}

export interface NormalizedTouchPoint {
  /** Timestamp in milliseconds since canvas mount. */
  t: number;
  /** Coordinates in [0, 1] relative to the canvas. */
  x: number;
  y: number;
  pressure: number;
}

interface LissajousCanvasProps {
  params: LissajousParams;
  width?: number;
  height?: number;
  active?: boolean;
  durationMs?: number;
  /**
   * When provided, the canvas wraps in a PanGesture and forwards every
   * touch sample (normalised to [0, 1]) to the caller for recording.
   * Without it the canvas runs an auto-replay preview.
   */
  onTouchPoint?: (point: NormalizedTouchPoint) => void;
}

const generatePoints = (params: LissajousParams, n: number): { x: number; y: number }[] => {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * Math.PI * 2;
    const x = Math.sin(params.a * t + params.delta);
    const y = Math.sin(params.b * t);
    points.push({ x, y });
  }
  return points;
};

const buildPath = (points: { x: number; y: number }[], w: number, h: number): string => {
  const padX = 14;
  const padY = 14;
  const rx = w / 2 - padX;
  const ry = h / 2 - padY;
  const cx = w / 2;
  const cy = h / 2;
  return points
    .map(({ x, y }, i) => {
      const px = cx + x * rx;
      const py = cy + y * ry;
      return `${i === 0 ? "M" : "L"}${px.toFixed(2)} ${py.toFixed(2)}`;
    })
    .join(" ");
};

export const LissajousCanvas = ({
  params,
  width = 280,
  height = 180,
  active = true,
  durationMs = 12_000,
  onTouchPoint,
}: LissajousCanvasProps) => {
  const { palette } = useTheme();
  const points = useMemo(() => generatePoints(params, 220), [params]);
  const fullPath = useMemo(() => buildPath(points, width, height), [points, width, height]);
  const isInteractive = typeof onTouchPoint === "function";

  // Geometry constants (UI-thread-safe primitives).
  const padX = 14;
  const padY = 14;
  const rx = width / 2 - padX;
  const ry = height / 2 - padY;
  const cxBase = width / 2;
  const cyBase = height / 2;
  const a = params.a;
  const b = params.b;
  const delta = params.delta;

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
    return { cx: cxBase + x * rx, cy: cyBase + y * ry };
  });

  // Live cursor position — driven directly by the gesture worklet on the UI
  // thread, so finger tracking does not trigger React re-renders.
  const liveCursorX = useSharedValue(cxBase);
  const liveCursorY = useSharedValue(cyBase);
  const startedAtMs = useSharedValue<number>(0);

  const liveCursorProps = useAnimatedProps(() => ({
    cx: liveCursorX.value,
    cy: liveCursorY.value,
  }));

  // The gesture callback is a worklet running on the UI thread. It updates
  // the sharedValues directly (zero React work), then bridges to the JS
  // thread via runOnJS only to push the touch sample into the recorder.
  const dispatchTouch = (t: number, x: number, y: number) => {
    onTouchPoint?.({ t, x, y, pressure: 1 });
  };

  const pan = Gesture.Pan()
    .minDistance(0)
    .onTouchesDown((event) => {
      "worklet";
      const touch = event.allTouches[0];
      if (!touch) return;
      const nx = Math.max(0, Math.min(1, touch.x / width));
      const ny = Math.max(0, Math.min(1, touch.y / height));
      liveCursorX.value = cxBase + (nx * 2 - 1) * rx;
      liveCursorY.value = cyBase + (ny * 2 - 1) * ry;
      const tMs = startedAtMs.value > 0 ? Date.now() - startedAtMs.value : 0;
      runOnJS(dispatchTouch)(tMs, nx, ny);
    })
    .onTouchesMove((event) => {
      "worklet";
      const touch = event.allTouches[0];
      if (!touch) return;
      const nx = Math.max(0, Math.min(1, touch.x / width));
      const ny = Math.max(0, Math.min(1, touch.y / height));
      liveCursorX.value = cxBase + (nx * 2 - 1) * rx;
      liveCursorY.value = cyBase + (ny * 2 - 1) * ry;
      const tMs = startedAtMs.value > 0 ? Date.now() - startedAtMs.value : 0;
      runOnJS(dispatchTouch)(tMs, nx, ny);
    });

  const onLayout = (_: LayoutChangeEvent) => {
    if (startedAtMs.value === 0) startedAtMs.value = Date.now();
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
