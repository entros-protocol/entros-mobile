import { COARSE_PATH_POINTS, OUTLINE_MARGIN } from "../coarsePath";
import {
  advanceReached,
  createRoundTracker,
  FLOOR_PERCENTILE,
  FLOOR_RATIO,
  FRAME_SAMPLES,
  frameRms,
  HISTORY_FRAMES,
  MAX_GAP_FRAMES,
  MIN_FLOOR_RMS,
  MIN_SPEECH_RMS,
  MIN_VOICED_FRAMES,
  OPEN_STALL_FRAMES,
  QUIET_FRAMES,
  STALL_FRAMES,
  VOICED_TO_GAP_RATIO,
  WAYPOINT_REACH,
  type RoundDecision,
} from "../tracker";

import { points, vectors } from "./vectors";

function expand(levels: readonly [number, number][]): number[] {
  return levels.flatMap(([level, count]) => Array.from({ length: count }, () => level));
}

function runLength(values: readonly RoundDecision[]): [string, number][] {
  const out: [string, number][] = [];
  for (const value of values) {
    const last = out[out.length - 1];
    if (last && last[0] === value) last[1]++;
    else out.push([value, 1]);
  }
  return out;
}

describe("round tracker constants", () => {
  test("match the generator's tracker block", () => {
    expect({
      frameSamples: FRAME_SAMPLES,
      waypointReach: WAYPOINT_REACH,
      outlineMargin: OUTLINE_MARGIN,
      coarsePathPoints: COARSE_PATH_POINTS,
      minVoicedFrames: MIN_VOICED_FRAMES,
      maxGapFrames: MAX_GAP_FRAMES,
      voicedToGapRatio: VOICED_TO_GAP_RATIO,
      quietFrames: QUIET_FRAMES,
      stallFrames: STALL_FRAMES,
      openStallFrames: OPEN_STALL_FRAMES,
      floorRatio: FLOOR_RATIO,
      floorPercentile: FLOOR_PERCENTILE,
      historyFrames: HISTORY_FRAMES,
      minSpeechRms: MIN_SPEECH_RMS,
      minFloorRms: MIN_FLOOR_RMS,
    }).toEqual(vectors.tracker);
  });
});

describe("round tracker sequences", () => {
  test.each(vectors.trackerSequences.map((vector) => [vector.name, vector] as const))(
    "%s",
    (_name, vector) => {
      const tracker = createRoundTracker();
      for (const level of expand(vector.priorLevels)) tracker.observe(level);
      tracker.begin(points(vector.waypoints), vector.traceRequired);

      const reachesByFrame = new Map<number, [number, number][]>();
      for (const [frame, x, y] of vector.reaches) {
        reachesByFrame.set(frame, [...(reachesByFrame.get(frame) ?? []), [x, y]]);
      }

      const decisions = expand(vector.levels).map((level, frame) => {
        for (const [x, y] of reachesByFrame.get(frame) ?? []) tracker.reach(x, y);
        return tracker.frame(level);
      });

      expect(runLength(decisions)).toEqual(vector.decisions);
      const completed = decisions.indexOf("complete");
      expect(completed === -1 ? null : completed).toBe(vector.completedAtFrame);
      expect(tracker.runs()).toEqual(vector.finalRuns);
    },
  );
});

describe("round tracker behaviour", () => {
  const waypoints = [
    { x: 200, y: 200 },
    { x: 500, y: 700 },
    { x: 800, y: 300 },
  ];

  test("reaches a waypoint at exactly the reach distance and not one unit beyond", () => {
    const tracker = createRoundTracker();
    tracker.begin(waypoints, true);
    tracker.reach(260, 280);
    tracker.reach(500, 801);
    tracker.reach(800, 300);
    // 60-80-100 reaches the first waypoint. The second sits 101 units away.
    for (let frame = 0; frame < OPEN_STALL_FRAMES; frame++) {
      expect(tracker.frame(0.001)).toBe("open");
    }
    expect(tracker.frame(0.001)).toBe("stalled");
  });

  test("a point reaches only the next unreached waypoint, and several in a row", () => {
    // The second waypoint first: nothing counts until the first is reached.
    expect(advanceReached(waypoints, 0, { x: 500, y: 700 })).toBe(0);
    expect(advanceReached(waypoints, 0, { x: 200, y: 200 })).toBe(1);
    expect(advanceReached(waypoints, 1, { x: 200, y: 200 })).toBe(1);
    const stacked = [
      { x: 500, y: 500 },
      { x: 540, y: 500 },
      { x: 580, y: 500 },
    ];
    expect(advanceReached(stacked, 0, { x: 540, y: 500 })).toBe(3);
    expect(advanceReached(stacked, 3, { x: 540, y: 500 })).toBe(3);
  });

  test("a new round keeps the level history and resets the round", () => {
    const tracker = createRoundTracker();
    for (let frame = 0; frame < 40; frame++) tracker.observe(0.02);
    tracker.begin([], false);
    for (let frame = 0; frame < 10; frame++) tracker.frame(0.05);
    expect(tracker.runs()).toEqual([]);
    tracker.begin([], false);
    expect(tracker.runs()).toEqual([]);
    expect(tracker.frame(0.2)).toBe("open");
    expect(tracker.runs()).toEqual([
      { startFrame: 0, endFrame: 1, voicedFrames: 1, gapFrames: 0, qualifies: false },
    ]);
  });

  test("keeps at most the history bound of round frames", () => {
    const tracker = createRoundTracker();
    tracker.begin([], false);
    for (let frame = 0; frame < HISTORY_FRAMES + 50; frame++) tracker.frame(0.001);
    for (let frame = 0; frame < 6; frame++) tracker.frame(0.05);
    const [run] = tracker.runs();
    expect(run?.endFrame).toBe(HISTORY_FRAMES);
    expect(run?.startFrame).toBe(HISTORY_FRAMES - 6);
  });

  test("the noise floor forgets levels older than the history bound", () => {
    const tracker = createRoundTracker();
    for (let frame = 0; frame < HISTORY_FRAMES; frame++) tracker.observe(0.02);
    tracker.begin([], false);
    for (let frame = 0; frame < HISTORY_FRAMES; frame++) tracker.frame(0.001);
    for (let frame = 0; frame < 6; frame++) tracker.frame(0.05);
    expect(tracker.runs()).toEqual([
      {
        startFrame: HISTORY_FRAMES - 6,
        endFrame: HISTORY_FRAMES,
        voicedFrames: 6,
        gapFrames: 0,
        qualifies: true,
      },
    ]);
  });

  test("the incremental floor matches a full sort of the last history frames", () => {
    const tracker = createRoundTracker();
    tracker.begin([], false);
    const levels: number[] = [];
    let state = 0x2545f491;
    for (let frame = 0; frame < HISTORY_FRAMES * 2 + 123; frame++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
      const level = ((state >>> 8) % 1_000) / 20_000;
      levels.push(level);
      tracker.frame(level);
      if (frame % 397 !== 0) continue;
      const recent = levels.slice(-HISTORY_FRAMES);
      const ordered = [...recent].sort((left, right) => left - right);
      const floor = Math.max(
        MIN_FLOOR_RMS,
        ordered[Math.floor(FLOOR_PERCENTILE * (ordered.length - 1))]!,
      );
      const bar = Math.max(MIN_SPEECH_RMS, floor * FLOOR_RATIO);
      const voiced = recent.filter((value) => value >= bar).length;
      const counted = tracker.runs().reduce((sum, run) => sum + run.voicedFrames, 0);
      expect(counted).toBe(voiced);
    }
  });

  test("refuses round frames before begin and non-finite levels", () => {
    const tracker = createRoundTracker();
    expect(() => tracker.frame(0.01)).toThrow();
    expect(() => tracker.reach(1, 1)).toThrow();
    expect(tracker.runs()).toEqual([]);
    expect(() => tracker.observe(Number.NaN)).toThrow(RangeError);
  });

  test("frame RMS is the root of the mean square over one frame", () => {
    const frame = new Float32Array(FRAME_SAMPLES);
    frame.fill(0.5, 0, FRAME_SAMPLES / 2);
    frame.fill(-0.5, FRAME_SAMPLES / 2);
    expect(frameRms(frame)).toBe(0.5);
    expect(frameRms(new Float32Array(FRAME_SAMPLES))).toBe(0);
    expect(() => frameRms(new Float32Array(FRAME_SAMPLES - 1))).toThrow(RangeError);
  });
});
