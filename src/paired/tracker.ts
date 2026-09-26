// Round tracker. Decides when a paired round is complete from the audio level of each
// 800-sample frame on the canonical 16 kHz clock and from the waypoints the trace reached,
// in the issued order.
//
// Every constant is a frame count, so the browser and the app reach the same decision from
// the same audio. The shared vectors pin the decision sequences. Floating-point comparisons
// follow the reference exactly, including recomputing every run against the current speech
// bar on each frame: a word spoken before the room's floor is known must count once quiet
// frames arrive.

import type { GridPoint } from "./transcript";

export const FRAME_SAMPLES = 800;
/** Grid units. A trace point within this distance of a waypoint reaches it. */
export const WAYPOINT_REACH = 100;
export const MIN_VOICED_FRAMES = 4;
export const MAX_GAP_FRAMES = 2;
/** A run needs at least this many voiced frames per gap frame. Rejects click trains. */
export const VOICED_TO_GAP_RATIO = 2;
export const QUIET_FRAMES = 12;
export const STALL_FRAMES = 80;
export const OPEN_STALL_FRAMES = 300;
export const FLOOR_RATIO = 4;
export const FLOOR_PERCENTILE = 0.1;
/** Levels kept for the noise floor, and frames kept for one round. Bounds per-frame work. */
export const HISTORY_FRAMES = 2_400;
export const MIN_SPEECH_RMS = 0.01;
export const MIN_FLOOR_RMS = 0.002;

export type RoundDecision = "open" | "complete" | "stalled";

/** A voiced run in frames from the round's first frame. `endFrame` is exclusive. */
export interface VoicedRun {
  startFrame: number;
  endFrame: number;
  voicedFrames: number;
  gapFrames: number;
  qualifies: boolean;
}

export interface RoundTracker {
  /** Feeds a frame level before the round starts, so the floor is known early. */
  observe(level: number): void;
  /** Starts a round. Level history carries over from earlier frames and rounds. */
  begin(waypoints: readonly GridPoint[], traceRequired: boolean): void;
  /**
   * Records a trace position in grid units. Call it before the frame it belongs to. It counts
   * toward the next unreached waypoint only.
   */
  reach(x: number, y: number): void;
  /** Feeds one round frame and returns the decision after it. */
  frame(level: number): RoundDecision;
  /** The voiced runs of the current round against the current speech bar. */
  runs(): VoicedRun[];
}

/** RMS of one frame: the f64 sum of squares over the frame length, then the root. */
export function frameRms(samples: Float32Array): number {
  if (samples.length !== FRAME_SAMPLES) {
    throw new RangeError(`A tracker frame has ${FRAME_SAMPLES} samples, got ${samples.length}.`);
  }
  let sumSquares = 0;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples.length);
}

// The last HISTORY_FRAMES levels, kept both in arrival order and sorted. The sorted copy
// makes the floor percentile a lookup, and each update costs one bounded shift.
class LevelHistory {
  private readonly ring = new Float64Array(HISTORY_FRAMES);
  private readonly sorted = new Float64Array(HISTORY_FRAMES);
  private head = 0;
  private size = 0;

  push(level: number): void {
    if (this.size === HISTORY_FRAMES) {
      const evicted = this.lowerBound(this.ring[this.head]!, this.size);
      this.sorted.copyWithin(evicted, evicted + 1, this.size);
      this.ring[this.head] = level;
      this.head = (this.head + 1) % HISTORY_FRAMES;
      this.insertSorted(level, this.size - 1);
    } else {
      this.ring[(this.head + this.size) % HISTORY_FRAMES] = level;
      this.insertSorted(level, this.size);
      this.size++;
    }
  }

  speechBar(): number {
    const percentile =
      this.size === 0
        ? MIN_FLOOR_RMS
        : this.sorted[Math.floor(FLOOR_PERCENTILE * (this.size - 1))]!;
    const floor = Math.max(MIN_FLOOR_RMS, percentile);
    return Math.max(MIN_SPEECH_RMS, floor * FLOOR_RATIO);
  }

  private lowerBound(value: number, length: number): number {
    let low = 0;
    let high = length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.sorted[middle]! < value) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private insertSorted(value: number, length: number): void {
    const position = this.lowerBound(value, length);
    this.sorted.copyWithin(position + 1, position, length);
    this.sorted[position] = value;
  }
}

interface RoundState {
  waypoints: readonly GridPoint[];
  traceRequired: boolean;
  /** Waypoints reached in the issued order, counted from the first. */
  reached: number;
  levels: number[];
  tracedAt: number | null;
  reported: boolean;
}

/**
 * How many waypoints a trace has reached in the issued order once it adds `point`. The point
 * counts only toward the next unreached waypoint, and it may reach several in a row.
 */
export function advanceReached(
  waypoints: readonly GridPoint[],
  reached: number,
  point: GridPoint,
): number {
  let next = reached;
  for (let waypoint = waypoints[next]; waypoint; waypoint = waypoints[next]) {
    const dx = point.x - waypoint.x;
    const dy = point.y - waypoint.y;
    if (dx * dx + dy * dy > WAYPOINT_REACH * WAYPOINT_REACH) break;
    next++;
  }
  return next;
}

function assertLevel(level: number): void {
  if (!Number.isFinite(level)) throw new RangeError("A frame level must be finite.");
}

function voicedRuns(levels: readonly number[], bar: number): VoicedRun[] {
  const runs: VoicedRun[] = [];
  let index = 0;
  while (index < levels.length) {
    if (levels[index]! < bar) {
      index++;
      continue;
    }
    const start = index;
    let last = index;
    let voicedFrames = 0;
    let gapFrames = 0;
    let pending = 0;
    for (let cursor = index; cursor < levels.length; cursor++) {
      if (levels[cursor]! >= bar) {
        voicedFrames++;
        gapFrames += pending;
        pending = 0;
        last = cursor;
      } else {
        pending++;
        if (pending > MAX_GAP_FRAMES) break;
      }
    }
    runs.push({
      startFrame: start,
      endFrame: last + 1,
      voicedFrames,
      gapFrames,
      qualifies:
        voicedFrames >= MIN_VOICED_FRAMES && voicedFrames >= VOICED_TO_GAP_RATIO * gapFrames,
    });
    index = last + 1;
  }
  return runs;
}

function lastVoicedFrame(levels: readonly number[], bar: number): number | null {
  for (let index = levels.length - 1; index >= 0; index--) {
    if (levels[index]! >= bar) return index;
  }
  return null;
}

export function createRoundTracker(): RoundTracker {
  const history = new LevelHistory();
  let round: RoundState | null = null;

  function requireRound(): RoundState {
    if (!round) throw new Error("The round tracker needs begin() before round frames.");
    return round;
  }

  function observe(level: number): void {
    assertLevel(level);
    history.push(level);
  }

  return {
    observe,

    begin(waypoints, traceRequired) {
      round = {
        waypoints: waypoints.map((point) => ({ x: point.x, y: point.y })),
        traceRequired,
        reached: 0,
        levels: [],
        tracedAt: null,
        reported: false,
      };
    },

    reach(x, y) {
      const state = requireRound();
      state.reached = advanceReached(state.waypoints, state.reached, { x, y });
    },

    frame(level) {
      const state = requireRound();
      observe(level);
      state.levels.push(level);
      if (state.levels.length > HISTORY_FRAMES) state.levels.shift();
      const now = state.levels.length - 1;

      const traced =
        !state.traceRequired ||
        (state.waypoints.length > 0 && state.reached === state.waypoints.length);
      if (!traced) return now >= OPEN_STALL_FRAMES ? "stalled" : "open";
      if (state.tracedAt === null) state.tracedAt = now;
      if (state.reported) return "stalled";

      const bar = history.speechBar();
      const spoken = voicedRuns(state.levels, bar).some((run) => run.qualifies);
      const lastVoiced = lastVoicedFrame(state.levels, bar);
      if (spoken && lastVoiced !== null && now - lastVoiced >= QUIET_FRAMES) {
        state.reported = true;
        return "complete";
      }
      return now - state.tracedAt >= STALL_FRAMES ? "stalled" : "open";
    },

    runs() {
      return round ? voicedRuns(round.levels, history.speechBar()) : [];
    },
  };
}
