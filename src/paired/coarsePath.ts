// Coarse path: the pressed trace reduced to a fixed number of grid points, and the rule the
// server applies to it.
//
// The committed outline carries no timestamps, pressure or raw touch. It resamples the
// pressed points evenly along the trace's length and quantises each to the integer grid, so
// only the shape of the trace reaches the wire. Resampling by length keeps the outline within
// half a spacing of the trace however its speed varied: a pause at one point adds no outline
// points there and takes none from the rest.

import { WAYPOINT_REACH } from "./tracker";
import { COORDINATE_MAX, MAX_PATH_POINTS, MIN_PATH_POINTS, type GridPoint } from "./transcript";

/** Points in each committed outline. */
export const COARSE_PATH_POINTS = 64;
/**
 * The outline joins points spaced along the trace, so it can cut the corner at a waypoint the
 * trace itself passed through. Reach on the outline is widened by this many grid units.
 */
export const OUTLINE_MARGIN = 30;

/** One pressed-stroke sample in surface pixels. `t` is in any monotonic unit and only orders. */
export interface TraceSample {
  x: number;
  y: number;
  t: number;
}

export interface TraceSurface {
  width: number;
  height: number;
}

export type CoarsePathErrorReason = "too_few_samples" | "zero_length" | "invalid_sample";

export class CoarsePathError extends Error {
  readonly reason: CoarsePathErrorReason;

  constructor(reason: CoarsePathErrorReason) {
    super(reason);
    this.name = "CoarsePathError";
    this.reason = reason;
  }
}

/** Rounds half toward positive infinity, as `Math.round` does, and clamps to the grid. */
function clampToGrid(value: number): number {
  return Math.max(0, Math.min(COORDINATE_MAX, Math.round(value)));
}

function assertSurface(surface: TraceSurface): void {
  if (
    !Number.isFinite(surface.width) ||
    !Number.isFinite(surface.height) ||
    surface.width <= 0 ||
    surface.height <= 0
  ) {
    throw new RangeError("The trace surface needs a positive finite width and height.");
  }
}

/** Maps one surface position onto the 0 to 1000 grid that waypoints and paths share. */
export function toGridPoint(x: number, y: number, surface: TraceSurface): GridPoint {
  assertSurface(surface);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new CoarsePathError("invalid_sample");
  }
  return {
    x: clampToGrid((x / surface.width) * COORDINATE_MAX),
    y: clampToGrid((y / surface.height) * COORDINATE_MAX),
  };
}

/**
 * Resamples pressed-stroke samples to `count` points spaced evenly along the trace's length,
 * interpolating on the unrounded grid, then quantises each point. Samples are ordered by `t`,
 * and samples that share a `t` keep their arrival order. A trace with no length is refused.
 */
export function toCoarsePath(
  samples: readonly TraceSample[],
  surface: TraceSurface,
  count: number = COARSE_PATH_POINTS,
): GridPoint[] {
  if (!Number.isInteger(count) || count < MIN_PATH_POINTS || count > MAX_PATH_POINTS) {
    throw new RangeError(
      `A coarse path has ${MIN_PATH_POINTS} to ${MAX_PATH_POINTS} points, got ${count}.`,
    );
  }
  assertSurface(surface);
  if (samples.some((sample) => ![sample.x, sample.y, sample.t].every(Number.isFinite))) {
    throw new CoarsePathError("invalid_sample");
  }
  if (samples.length < 2) throw new CoarsePathError("too_few_samples");

  // The index breaks ties, so the order never depends on the engine's sort.
  const ordered = samples
    .map((sample, index) => ({ sample, index }))
    .sort((left, right) => left.sample.t - right.sample.t || left.index - right.index)
    .map(({ sample }) => ({
      x: (sample.x / surface.width) * COORDINATE_MAX,
      y: (sample.y / surface.height) * COORDINATE_MAX,
    }));
  const along = [0];
  for (let index = 1; index < ordered.length; index++) {
    const dx = ordered[index]!.x - ordered[index - 1]!.x;
    const dy = ordered[index]!.y - ordered[index - 1]!.y;
    along.push(along[index - 1]! + Math.sqrt(dx * dx + dy * dy));
  }
  const total = along[along.length - 1]!;
  if (!(total > 0)) throw new CoarsePathError("zero_length");

  const points: GridPoint[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    const at = (total * index) / (count - 1);
    while (cursor < ordered.length - 2 && along[cursor + 1]! < at) cursor++;
    const left = ordered[cursor]!;
    const right = ordered[cursor + 1]!;
    const span = along[cursor + 1]! - along[cursor]!;
    const fraction = span > 0 ? Math.min(1, Math.max(0, (at - along[cursor]!) / span)) : 0;
    points.push({
      x: clampToGrid(left.x + (right.x - left.x) * fraction),
      y: clampToGrid(left.y + (right.y - left.y) * fraction),
    });
  }
  return points;
}

export interface PathScore {
  /** Waypoints reached in the issued order, counted from the first. */
  reached: number;
  /** Every waypoint was reached, in the issued order. */
  inOrder: boolean;
}

/**
 * Walks an outline from its start and counts the waypoints it reaches in the issued order,
 * by the rule the server applies to the committed outline. Each step runs from one outline
 * point to the next, and the last step is the final point alone. A waypoint counts when a step
 * passes within the widened reach of it, only after the one before it, and on the step that
 * reached the one before, only no earlier along that step.
 */
export function scorePath(
  waypoints: readonly GridPoint[],
  outline: readonly GridPoint[],
): PathScore {
  const reach = (WAYPOINT_REACH + OUTLINE_MARGIN) ** 2;
  let reached = 0;
  // Where the last waypoint was reached: its outline step and how far along it.
  let lastStep = -1;
  let lastAlong = 0;
  for (let step = 0; step < outline.length; step++) {
    const start = outline[step]!;
    const end = outline[Math.min(step + 1, outline.length - 1)]!;
    for (let waypoint = waypoints[reached]; waypoint; waypoint = waypoints[reached]) {
      const { distance, along } = closest(waypoint, start, end);
      if (distance > reach || (step === lastStep && along < lastAlong)) break;
      reached++;
      lastStep = step;
      lastAlong = along;
    }
  }
  return { reached, inOrder: waypoints.length > 0 && reached === waypoints.length };
}

/** Squared distance from `point` to a segment, and how far along it the closest point lies. */
function closest(
  point: GridPoint,
  start: GridPoint,
  end: GridPoint,
): { distance: number; along: number } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const along =
    lengthSquared === 0
      ? 0
      : Math.min(
          1,
          Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
        );
  const cx = start.x + along * dx - point.x;
  const cy = start.y + along * dy - point.y;
  return { distance: cx * cx + cy * cy, along };
}
