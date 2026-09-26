import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedProps, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import Svg, { Circle, Path, Polyline, Text as SvgText } from "react-native-svg";

import { COORDINATE_MAX, WAYPOINT_REACH, type GridPoint } from "@/paired";
import { fontFamily, radii } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** One pressed-stroke sample: surface pixels and the `Date.now()` instant it arrived. */
export interface WaypointSample {
  x: number;
  y: number;
  t: number;
}

interface WaypointCanvasProps {
  /** Side of the square surface in pixels. The 0 to 1000 grid spans it. */
  size: number;
  waypoints: readonly GridPoint[];
  /** Waypoints reached in order, counted from the first. */
  reached: number;
  /** Draws the stroke only while true. Pressed samples are forwarded either way. */
  active: boolean;
  /** Changes when a round begins, which clears the drawn stroke. */
  strokeKey: number;
  onSample: (sample: WaypointSample) => void;
}

const toPixels = (value: number, size: number): number => (value / COORDINATE_MAX) * size;

/** Most points the drawn stroke keeps. Reaching it thins the stroke to half. */
const MAX_STROKE_POINTS = 400;
/** Pixels a moving touch travels before it adds a drawn point. Doubles as the stroke thins. */
const MIN_STROKE_STEP = 2;

// The drawn stroke is kept as flat triples: x, y, and 1 where a stroke starts.

function strokePath(points: readonly number[]): string {
  "worklet";
  let path = "";
  for (let index = 0; index + 2 < points.length; index += 3) {
    const command = points[index + 2] === 1 ? "M" : "L";
    path += `${command}${points[index]!.toFixed(1)} ${points[index + 1]!.toFixed(1)}`;
  }
  return path;
}

/**
 * Keeps every other point and the newest. A kept point starts a stroke when it or a point
 * dropped before it did, so no line joins two separate strokes.
 */
function thinStroke(points: readonly number[]): number[] {
  "worklet";
  const kept: number[] = [];
  const newest = points.length - 3;
  let starts = false;
  for (let index = 0; index + 2 < points.length; index += 3) {
    starts = starts || points[index + 2] === 1;
    if ((index / 3) % 2 === 0 || index === newest) {
      kept.push(points[index]!, points[index + 1]!, starts ? 1 : 0);
      starts = false;
    }
  }
  return kept;
}

// The recorder maps a touch to an audio sample through this same wall clock.
const wallClockNow = (): number => {
  "worklet";
  return Date.now();
};

/**
 * The trace surface for a paired round. The gesture reports touches only while
 * a finger is down, so every forwarded sample belongs to a pressed stroke and
 * a lost release can never turn hovering into drawing.
 */
export const WaypointCanvas = ({
  size,
  waypoints,
  reached,
  active,
  strokeKey,
  onSample,
}: WaypointCanvasProps) => {
  const { palette } = useTheme();
  const stroke = useSharedValue("");
  const strokePoints = useSharedValue<number[]>([]);
  const strokeStep = useSharedValue(MIN_STROKE_STEP);
  const drawing = useSharedValue(active);

  useEffect(() => {
    drawing.set(active);
  }, [active, drawing]);

  useEffect(() => {
    strokePoints.set([]);
    strokeStep.set(MIN_STROKE_STEP);
    stroke.set("");
  }, [strokeKey, stroke, strokePoints, strokeStep]);

  const strokeProps = useAnimatedProps(() => ({ d: stroke.get() }));

  const forward = (x: number, y: number, t: number) => onSample({ x, y, t });

  // Every touch is forwarded. Only the drawn stroke is thinned, so it stays
  // bounded however long the trace runs.
  const draw = (x: number, y: number, pressed: boolean) => {
    "worklet";
    if (!drawing.get()) return;
    strokePoints.modify((points) => {
      "worklet";
      const starts = pressed || points.length === 0;
      if (!starts) {
        const dx = x - points[points.length - 3]!;
        const dy = y - points[points.length - 2]!;
        const step = strokeStep.get();
        if (dx * dx + dy * dy < step * step) return points;
      }
      points.push(x, y, starts ? 1 : 0);
      if (points.length / 3 > MAX_STROKE_POINTS) {
        const kept = thinStroke(points);
        strokeStep.set(strokeStep.get() * 2);
        stroke.set(strokePath(kept));
        return kept;
      }
      stroke.set(`${stroke.get()}${starts ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`);
      return points;
    });
  };

  const pan = Gesture.Pan()
    .minDistance(0)
    .onTouchesDown((event) => {
      "worklet";
      const touch = event.allTouches[0];
      if (!touch) return;
      const x = Math.max(0, Math.min(size, touch.x));
      const y = Math.max(0, Math.min(size, touch.y));
      draw(x, y, true);
      scheduleOnRN(forward, x, y, wallClockNow());
    })
    .onTouchesMove((event) => {
      "worklet";
      const touch = event.allTouches[0];
      if (!touch) return;
      const x = Math.max(0, Math.min(size, touch.x));
      const y = Math.max(0, Math.min(size, touch.y));
      draw(x, y, false);
      scheduleOnRN(forward, x, y, wallClockNow());
    });

  const reach = toPixels(WAYPOINT_REACH, size);
  const guide = waypoints.map((point) => `${toPixels(point.x, size)},${toPixels(point.y, size)}`);

  return (
    <GestureDetector gesture={pan}>
      <View
        accessible
        accessibilityLabel="Trace surface. Draw a line through each numbered point in order."
        style={[
          styles.canvas,
          {
            width: size,
            height: size,
            backgroundColor: palette.surface,
            borderColor: palette.border,
            opacity: active ? 1 : 0.45,
          },
        ]}
      >
        <Svg width={size} height={size}>
          {guide.length > 1 ? (
            <Polyline
              points={guide.join(" ")}
              fill="none"
              stroke={palette.textSubtle}
              strokeWidth={2}
              strokeDasharray="6 8"
            />
          ) : null}
          {waypoints.map((point, index) => {
            const cx = toPixels(point.x, size);
            const cy = toPixels(point.y, size);
            const done = index < reached;
            return (
              <Circle
                key={`reach-${index}-${point.x}-${point.y}`}
                cx={cx}
                cy={cy}
                r={reach}
                fill={done ? palette.solanaGreen : palette.accent}
                opacity={done ? 0.16 : 0.1}
              />
            );
          })}
          <AnimatedPath
            animatedProps={strokeProps}
            fill="none"
            stroke={palette.accent}
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {waypoints.map((point, index) => {
            const cx = toPixels(point.x, size);
            const cy = toPixels(point.y, size);
            const done = index < reached;
            return (
              <Circle
                key={`dot-${index}-${point.x}-${point.y}`}
                cx={cx}
                cy={cy}
                r={11}
                fill={done ? palette.solanaGreen : palette.background}
                stroke={done ? palette.solanaGreen : palette.accent}
                strokeWidth={2}
              />
            );
          })}
          {waypoints.map((point, index) => (
            <SvgText
              key={`label-${index}-${point.x}-${point.y}`}
              x={toPixels(point.x, size)}
              y={toPixels(point.y, size) + 4}
              fontSize={11}
              fontFamily={fontFamily.semiBold}
              textAnchor="middle"
              fill={index < reached ? palette.background : palette.accent}
            >
              {index + 1}
            </SvgText>
          ))}
        </Svg>
      </View>
    </GestureDetector>
  );
};

const styles = StyleSheet.create({
  canvas: {
    borderRadius: radii.xl,
    borderWidth: 1,
    overflow: "hidden",
  },
});
