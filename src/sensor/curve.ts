import type { CurveTraceOutline, CurveTracePoint } from "./types";

export const CURVE_OUTLINE_POINTS = 64;
const COORDINATE_ENVELOPE = 10_000;

const roundOne = (value: number): number => Math.round(value * 10) / 10;

/** Build a timestamp-free, equal-time outline. Raw touch timing stays on-device. */
export function resampleCurveTrace(
  raw: CurveTracePoint[],
  pointCount = CURVE_OUTLINE_POINTS,
): CurveTraceOutline | undefined {
  if (!Number.isInteger(pointCount) || pointCount < 2) return undefined;
  const points = raw.filter(
    (point) =>
      Number.isFinite(point.t) &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      Math.abs(point.x) <= COORDINATE_ENVELOPE &&
      Math.abs(point.y) <= COORDINATE_ENVELOPE,
  );
  if (points.length < 2) return undefined;

  const firstAt = points[0]!.t;
  const duration = points[points.length - 1]!.t - firstAt;
  if (!Number.isFinite(duration) || duration <= 0) return undefined;

  const outline: [number, number][] = [];
  let cursor = 0;
  for (let index = 0; index < pointCount; index++) {
    const target = firstAt + (index / (pointCount - 1)) * duration;
    while (cursor < points.length - 2 && points[cursor + 1]!.t < target) cursor += 1;
    const left = points[cursor]!;
    const right = points[cursor + 1]!;
    const span = right.t - left.t;
    const fraction = span > 0 ? Math.min(1, Math.max(0, (target - left.t) / span)) : 0;
    outline.push([
      roundOne(left.x + (right.x - left.x) * fraction),
      roundOne(left.y + (right.y - left.y) * fraction),
    ]);
  }
  return { points: outline, duration_ms: roundOne(duration) };
}
