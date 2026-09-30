import { bytesToHex } from "@noble/hashes/utils.js";

import {
  advanceReached,
  encodeCoarsePath,
  encodePcm16,
  FRAME_SAMPLES,
  initialCommitment,
  parseOpenResponse,
  scorePath,
  toCoarsePath,
  type GridPoint,
  type PairedCommitResponse,
  type PairedRoundCommit,
  type TraceSample,
} from "@/paired";
import { parseCommitResponse } from "@/paired/client";
import { decodePcm16 } from "@/paired/segment";
import { MAX_ROUND_SAMPLES } from "@/paired/transcript";
import { PairedServiceError, type PairedFailure } from "@/services/pairedErrors";
import type { OpenedPairedSession } from "@/services/pairedExecutor";

import {
  createPairedSession,
  type CompletedPairedRounds,
  type PairedPhase,
  type PairedRecorder,
  type PairedRoundView,
  type PairedSessionDeps,
} from "../pairedSession";

import { accept, acceptJson, openJson, roundEntry, WALLET } from "./pairedFixtures";

const SURFACE = { width: 300, height: 300 };
/** Wall-clock ms per canonical sample in the fake recorder: sample i was recorded at i / 16. */
const SAMPLES_PER_MS = 16;
const QUIET = 0.001;
const VOICED = 0.1;
/** The `now` clock reading when the session opens. */
const OPENED_AT_MS = 1_000;

/** A recorder whose frames the test emits. A frame's samples all equal its level. */
class FakeRecorder implements PairedRecorder {
  readonly nativeSampleRate = 48_000;
  readonly ready = Promise.resolve();
  markNow(): number {
    return this.framedSamples();
  }
  private samples: number[] = [];
  private start = 0;
  stopped = false;

  constructor(private readonly onFrame: (level: number, endSample: number) => void) {}

  frames(levels: readonly number[]): void {
    for (const level of levels) {
      for (let index = 0; index < FRAME_SAMPLES; index++) this.samples.push(level);
      this.onFrame(level, this.start + this.samples.length);
    }
  }

  framedSamples(): number {
    return this.start + this.samples.length;
  }

  sampleIndexAt(wallClockMs: number): number {
    return Math.max(0, Math.round(wallClockMs * SAMPLES_PER_MS));
  }

  timeAt(sampleIndex: number): number {
    return sampleIndex / SAMPLES_PER_MS;
  }

  slice(from: number, to: number): Float32Array {
    if (from < this.start || to > this.framedSamples()) throw new RangeError("not held");
    return Float32Array.from(this.samples.slice(from - this.start, to - this.start));
  }

  releaseBefore(sampleIndex: number): void {
    const discard = Math.min(sampleIndex, this.framedSamples()) - this.start;
    if (discard <= 0) return;
    this.samples = this.samples.slice(discard);
    this.start += discard;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

interface FakeTimer {
  task: () => void;
  delayMs: number;
  cancelled: boolean;
}

interface HarnessOptions {
  respond?: (commit: PairedRoundCommit) => Promise<PairedCommitResponse>;
  open?: (now: number) => Promise<OpenedPairedSession>;
  cue?: PairedSessionDeps["cue"];
}

function harness(options: HarnessOptions = {}) {
  let recorder: FakeRecorder | null = null;
  const deferred: (() => void)[] = [];
  const timers: FakeTimer[] = [];
  const clock = { now: OPENED_AT_MS };
  const state = {
    commits: [] as PairedRoundCommit[],
    cues: [] as GridPoint[],
    levels: [] as [number, boolean][],
    deadlines: [] as number[],
    reveals: [] as PairedRoundView[],
    phases: [] as PairedPhase[],
    continueStates: [] as boolean[],
    failures: [] as PairedFailure[],
    /** One entry each time the session hands the host back to the single capture. */
    fallbacks: [] as string[],
    completed: [] as CompletedPairedRounds[],
  };
  const respond = options.respond ?? (async (commit) => accept(commit));
  const session = createPairedSession(
    {
      startRecorder: async (onFrame) => {
        recorder = new FakeRecorder(onFrame);
        return recorder;
      },
      open:
        options.open === undefined
          ? async () => ({ open: parseOpenResponse(openJson()), startedAtMs: clock.now })
          : () => options.open!(clock.now),
      cue:
        options.cue === undefined
          ? async (_open, reveal) => {
              const point = roundEntry(reveal.roundIndex).cuePoint;
              return {
                point: { x: point[0], y: point[1] },
                expiresInMs: 6000,
                startedAtMs: clock.now,
              };
            }
          : options.cue,
      commit: async (commit, deadlineMs) => {
        state.commits.push(commit);
        state.deadlines.push(deadlineMs);
        const startedAtMs = clock.now;
        return { ...(await respond(commit)), startedAtMs };
      },
      now: () => clock.now,
      randomBytes: (length) => new Uint8Array(length).fill(state.commits.length + 1),
      defer: (task) => {
        deferred.push(task);
      },
      setTimer: (task, delayMs) => {
        const timer = { task, delayMs, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    },
    {
      reveal: (view) => state.reveals.push(view),
      cue: (view) => state.cues.push(view.point),
      phase: (phase) => state.phases.push(phase),
      continueAvailable: (available) => state.continueStates.push(available),
      level: (rms, active) => state.levels.push([rms, active]),
      failure: (failure) => state.failures.push(failure),
      unavailable: () => state.fallbacks.push(WALLET),
      complete: (result) => state.completed.push(result),
    },
  );
  return {
    ...state,
    clock,
    session,
    recorder: () => {
      if (!recorder) throw new Error("The recorder has not started.");
      return recorder;
    },
    /** Timers still waiting to run. */
    pending: () => timers.filter((timer) => !timer.cancelled),
    flush: async () => {
      while (deferred.length > 0) deferred.shift()!();
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    },
  };
}

type Harness = ReturnType<typeof harness>;

function pixel(point: GridPoint): { x: number; y: number } {
  return { x: (point.x / 1000) * SURFACE.width, y: (point.y / 1000) * SURFACE.height };
}

/** Traces through `points`, stamped just after the recorder's current frame. */
function traceGrid(h: Harness, points: readonly GridPoint[]): TraceSample[] {
  const recorder = h.recorder();
  const baseMs = recorder.timeAt(recorder.framedSamples()) + 1;
  return points.map((point, index) => {
    const sample = { ...pixel(point), t: baseMs + index * 5 };
    h.session.trace(sample, SURFACE);
    return sample;
  });
}

/** Speech the tracker completes on: a voiced run, then the quiet that ends it. */
const SPOKEN = [...Array(6).fill(VOICED), ...Array(14).fill(QUIET)];

async function playRound(h: Harness): Promise<void> {
  const view = h.reveals[h.reveals.length - 1]!;
  traceGrid(h, view.waypoints);
  h.recorder().frames([QUIET, QUIET, ...SPOKEN]);
  await finishCue(h);
}

async function finishCue(h: Harness) {
  await h.flush();
  if (h.phases.at(-1) === "cue") {
    traceGrid(h, [h.cues.at(-1)!]);
    h.recorder().frames([QUIET]);
    await h.flush();
  }
}

describe("paired session rounds", () => {
  test("commits three rounds, revealing each only after the previous commit is accepted", async () => {
    let release: (() => void) | null = null;
    const h = harness({
      respond: async (commit) => {
        if (commit.body.round_index === 2) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return accept(commit);
      },
    });
    await h.session.start(WALLET);
    expect(h.reveals.map((view) => view.roundIndex)).toEqual([1]);
    const openedAt = h.recorder().framedSamples();

    await playRound(h);
    expect(h.commits).toHaveLength(1);
    expect(h.reveals.map((view) => view.roundIndex)).toEqual([1, 2]);

    await playRound(h);
    expect(h.commits).toHaveLength(2);
    // Round 3 stays hidden while round 2's commit is outstanding.
    h.recorder().frames(Array(20).fill(QUIET));
    await h.flush();
    expect(h.reveals).toHaveLength(2);
    release!();
    await h.flush();
    expect(h.reveals.map((view) => view.roundIndex)).toEqual([1, 2, 3]);

    await playRound(h);
    expect(h.commits.map((commit) => commit.body.round_index)).toEqual([1, 2, 3]);
    expect(h.completed).toHaveLength(1);
    expect(h.recorder().stopped).toBe(true);

    // The chain starts at C_0 and each round extends the previous commitment.
    const open = parseOpenResponse(openJson());
    let previous = bytesToHex(initialCommitment(open));
    for (const commit of h.commits) {
      expect(commit.body.previous_commitment).toBe(previous);
      expect(commit.body.wallet_id).toBe(WALLET);
      expect(commit.coarsePath.length).toBeGreaterThan(0);
      previous = commit.body.commitment;
    }

    // Waiting for the second commit is outside every committed interval.
    const lengths = h.commits.map((commit) => commit.segment.length / 2);
    expect(lengths.every((length) => length % FRAME_SAMPLES === 0)).toBe(true);
    const result = h.completed[0]!;
    expect(result.audioStartedAtMs).toBe(openedAt / SAMPLES_PER_MS);
    expect(result.audioEndedAtMs - result.audioStartedAtMs).toBe(
      (lengths.reduce((sum, length) => sum + length, 0) + 20 * FRAME_SAMPLES) / SAMPLES_PER_MS,
    );
    expect(result.commits).toHaveLength(3);
    expect(result.nativeSampleRate).toBe(48_000);
  });

  test("commits the canonical window as PCM16 with no per-round levelling", async () => {
    const h = harness();
    await h.session.start(WALLET);
    const start = h.recorder().framedSamples();
    await playRound(h);
    const segment = h.commits[0]!.segment;
    const end = start + segment.length / 2;
    const expected = encodePcm16(
      Float32Array.from({ length: end - start }, (_, index) => {
        const frame = Math.floor(index / FRAME_SAMPLES);
        return [QUIET, QUIET, ...SPOKEN, QUIET][frame]!;
      }),
    );
    expect(bytesToHex(segment)).toBe(bytesToHex(expected));
  });

  test("commits the outline of the round's trace that it scored", async () => {
    const h = harness();
    await h.session.start(WALLET);
    const view = h.reveals[0]!;
    const trace = traceGrid(h, view.waypoints);
    h.recorder().frames([QUIET, QUIET, ...SPOKEN]);
    await h.flush();
    trace.push(...traceGrid(h, [h.cues.at(-1)!]));
    h.recorder().frames([QUIET]);
    await h.flush();
    const outline = toCoarsePath(trace, SURFACE);
    expect(scorePath(view.waypoints, outline).inOrder).toBe(true);
    expect(bytesToHex(h.commits[0]!.coarsePath)).toBe(
      bytesToHex(encodeCoarsePath("trace", outline)),
    );
    expect(h.commits[0]!.body.path_point_count).toBe(outline.length);
  });

  test("excludes network waiting and preserves early quiet speech", async () => {
    let release: (() => void) | null = null;
    const h = harness({
      respond: async (commit) => {
        if (commit.body.round_index === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return accept(commit);
      },
    });
    await h.session.start(WALLET);
    await playRound(h);
    h.recorder().frames(Array(100).fill(0.3));
    release!();
    await h.flush();
    h.recorder().frames([QUIET, QUIET, ...Array(6).fill(0.007), ...Array(14).fill(QUIET)]);
    traceGrid(h, h.reveals[1]!.waypoints);
    h.recorder().frames([QUIET]);
    if (h.phases.at(-1) === "round") expect(h.session.continueRound()).toBe(true);
    await finishCue(h);
    const segment = decodePcm16(h.commits[1]!.segment);
    expect(segment).toHaveLength(24 * FRAME_SAMPLES);
    expect(segment[2 * FRAME_SAMPLES]).toBeCloseTo(0.007, 4);
    expect(Math.max(...segment)).toBeLessThan(0.01);
  });

  test("fails oversized capture without discarding early audio", async () => {
    const h = harness();
    await h.session.start(WALLET);
    h.recorder().frames(Array(MAX_ROUND_SAMPLES / FRAME_SAMPLES + 1).fill(QUIET));
    await h.flush();
    expect(h.failures).toEqual([{ reason: "evidence_bounds_invalid" }]);
    expect(h.commits).toHaveLength(0);
    expect(h.recorder().stopped).toBe(true);
  });

  test("offers Continue immediately after a valid outline and requests one cue", async () => {
    const h = harness();
    await h.session.start(WALLET);
    expect(h.session.continueRound()).toBe(false);
    traceGrid(h, h.reveals[0]!.waypoints);
    expect(h.continueStates).toEqual([true]);
    expect(h.session.continueRound()).toBe(true);
    expect(h.session.continueRound()).toBe(false);
    await h.flush();
    expect(h.cues).toHaveLength(1);
    expect(h.commits).toHaveLength(0);
    await finishCue(h);
    expect(h.commits).toHaveLength(1);
    expect(h.continueStates).toEqual([true, false]);
  });

  test("waits for a trace that forms a path before it ends a round", async () => {
    const h = harness();
    await h.session.start(WALLET);
    const view = h.reveals[0]!;
    // Pressed at the first point only: the trace has no length.
    traceGrid(h, [view.waypoints[0]!, view.waypoints[0]!]);
    h.recorder().frames([QUIET, QUIET, ...SPOKEN, ...Array(100).fill(QUIET)]);
    await h.flush();
    expect(h.commits).toHaveLength(0);
    expect(h.phases.at(-1)).toBe("round");
    expect(h.continueStates).toEqual([]);
    expect(h.session.continueRound()).toBe(false);

    traceGrid(h, view.waypoints.slice(1));
    expect(h.continueStates).toEqual([true]);
    expect(h.session.continueRound()).toBe(true);
    await finishCue(h);
    expect(h.commits).toHaveLength(1);
  });

  test("counts waypoints only in the issued order", async () => {
    const h = harness();
    await h.session.start(WALLET);
    const view = h.reveals[0]!;
    traceGrid(h, [...view.waypoints].reverse());
    h.recorder().frames([QUIET, QUIET, ...SPOKEN, ...Array(100).fill(QUIET)]);
    await h.flush();
    expect(h.commits).toHaveLength(0);
    expect(h.continueStates).toEqual([]);
    // Speech the tracker heard does not stand in for a trace in the wrong order.
    expect(h.session.continueRound()).toBe(false);
  });

  test("ends a round only when its outline passes the server's path rule", async () => {
    const h = harness();
    await h.session.start(WALLET);
    const view = h.reveals[0]!;
    // Every waypoint is touched in order, each by one point at the tip of a
    // narrow spike off a long detour. The outline spaces its points along the
    // whole length, so it passes wide of the spike tips.
    const detour = Array.from({ length: 16 }, (_, index) =>
      index % 2 === 0 ? { x: 950, y: 1000 } : { x: 1000, y: 0 },
    );
    const spike = (point: GridPoint) => [{ x: 950, y: point.y }, point, { x: 950, y: point.y }];
    const [first, ...rest] = view.waypoints;
    const path = [
      first!,
      { x: 950, y: first!.y },
      ...rest.flatMap((point) => [...detour, ...spike(point)]),
    ];
    const trace = traceGrid(h, path);
    expect(path.reduce((reached, point) => advanceReached(view.waypoints, reached, point), 0)).toBe(
      view.waypoints.length,
    );
    expect(scorePath(view.waypoints, toCoarsePath(trace, SURFACE)).inOrder).toBe(false);

    h.recorder().frames([QUIET, QUIET, ...SPOKEN, ...Array(100).fill(QUIET)]);
    await h.flush();
    expect(h.commits).toHaveLength(0);
    expect(h.phases.at(-1)).toBe("round");
    expect(h.continueStates).toEqual([]);
    expect(h.session.continueRound()).toBe(false);
  });

  test.each([0, 160])(
    "retains speech during outline recovery after %i extra frames",
    async (delay) => {
      const h = harness();
      await h.session.start(WALLET);
      const view = h.reveals[0]!;
      const detour = Array.from({ length: 16 }, (_, index) =>
        index % 2 === 0 ? { x: 950, y: 1000 } : { x: 1000, y: 0 },
      );
      const [first, ...rest] = view.waypoints;
      const path = [
        first!,
        { x: 950, y: first!.y },
        ...rest.flatMap((point) => [
          ...detour,
          { x: 950, y: point.y },
          point,
          { x: 950, y: point.y },
        ]),
      ];
      const trace = traceGrid(h, path);
      expect(scorePath(view.waypoints, toCoarsePath(trace, SURFACE)).inOrder).toBe(false);
      h.recorder().frames([QUIET, QUIET, ...Array(6).fill(0.02), ...Array(14).fill(QUIET)]);
      await h.flush();
      expect(h.commits).toHaveLength(0);
      expect(h.session.continueRound()).toBe(false);

      h.recorder().frames(Array(delay).fill(0.008));
      const repair = traceGrid(h, Array.from({ length: 10 }, () => view.waypoints).flat());
      expect(scorePath(view.waypoints, toCoarsePath([...trace, ...repair], SURFACE)).inOrder).toBe(
        true,
      );
      h.recorder().frames(Array(10).fill(QUIET));
      await finishCue(h);
      expect(h.commits).toHaveLength(1);
      expect(h.reveals.map((round) => round.roundIndex)).toEqual([1, 2]);
      const segment = decodePcm16(h.commits[0]!.segment);
      expect(segment[2 * FRAME_SAMPLES]).toBeCloseTo(0.02, 3);
      expect(segment[8 * FRAME_SAMPLES - 1]).toBeCloseTo(0.02, 3);
      if (delay > 0) expect(segment).toHaveLength((22 + delay + 10 + 1) * FRAME_SAMPLES);

      traceGrid(h, h.reveals[1]!.waypoints);
      h.recorder().frames(Array(100).fill(QUIET));
      await h.flush();
      expect(h.commits).toHaveLength(1);
      h.session.abort();
    },
  );

  test("ignores touches outside a round", async () => {
    const h = harness({ respond: () => new Promise<PairedCommitResponse>(() => undefined) });
    await h.session.start(WALLET);
    await playRound(h);
    expect(h.phases.at(-1)).toBe("committing");
    h.session.trace({ x: 10, y: 10, t: 999_999 }, SURFACE);
    expect(h.session.continueRound()).toBe(false);
  });

  test("ends the session on a terminal commit rejection and stops the recorder", async () => {
    const h = harness({
      respond: async () => {
        throw new PairedServiceError({ reason: "session_superseded", status: 409 });
      },
    });
    await h.session.start(WALLET);
    await playRound(h);
    expect(h.failures).toEqual([{ reason: "session_superseded", status: 409 }]);
    expect(h.phases.at(-1)).toBe("failed");
    expect(h.recorder().stopped).toBe(true);
    expect(h.reveals).toHaveLength(1);
    expect(h.pending()).toEqual([]);
  });

  test("reports an open failure and a microphone failure once", async () => {
    const failures: PairedFailure[] = [];
    let micFailure: ((error: Error) => void) | null = null;
    const session = createPairedSession(
      {
        startRecorder: async (onFrame, onFailure) => {
          micFailure = onFailure;
          return new FakeRecorder(onFrame);
        },
        open: async () => {
          throw new PairedServiceError({
            reason: "capacity_reached",
            status: 429,
            retryAfterSec: 5,
          });
        },
        cue: async () => {
          throw new Error("unreachable");
        },
        commit: async (commit) => ({ ...accept(commit), startedAtMs: 0 }),
        now: () => 0,
        randomBytes: (length) => new Uint8Array(length),
        defer: (task) => task(),
        setTimer: () => () => undefined,
      },
      {
        reveal: () => undefined,
        cue: () => undefined,
        phase: () => undefined,
        continueAvailable: () => undefined,
        level: () => undefined,
        failure: (failure) => failures.push(failure),
        unavailable: () => undefined,
        complete: () => undefined,
      },
    );
    await session.start(WALLET);
    micFailure!(new Error("AudioRecord read failed (-3)"));
    expect(failures).toEqual([{ reason: "capacity_reached", status: 429, retryAfterSec: 5 }]);
  });

  test("hands a relayer without paired sessions back to the host instead of failing", async () => {
    const h = harness({
      open: async () => {
        throw new PairedServiceError({ reason: "unsupported_session", status: 404 });
      },
    });
    await h.session.start(WALLET);
    expect(h.fallbacks).toEqual([WALLET]);
    expect(h.failures).toEqual([]);
    expect(h.reveals).toEqual([]);
    expect(h.recorder().stopped).toBe(true);
  });

  test("cancellation erases copied round audio still owned by the controller", async () => {
    const h = harness();
    await h.session.start(WALLET);
    await playRound(h);
    const audio = h.commits[0]!.segment;
    expect(audio.some((value) => value !== 0)).toBe(true);
    await h.session.abort();
    expect(audio.every((value) => value === 0)).toBe(true);
  });

  test("abort stops the recorder and the round's timer without reporting", async () => {
    const h = harness();
    await h.session.start(WALLET);
    expect(h.pending()).toHaveLength(1);
    await h.session.abort();
    expect(h.recorder().stopped).toBe(true);
    expect(h.pending()).toEqual([]);
    await playRound(h);
    expect(h.commits).toHaveLength(0);
    expect(h.failures).toEqual([]);
  });
});

describe("paired session deadlines", () => {
  test("ends a round that outlives its reveal with round_expired", async () => {
    const h = harness();
    await h.session.start(WALLET);
    const [timer] = h.pending();
    expect(timer!.delayMs).toBe(12_000);
    timer!.task();
    expect(h.failures).toEqual([{ reason: "round_expired" }]);
    expect(h.phases.at(-1)).toBe("failed");
    expect(h.recorder().stopped).toBe(true);
    await playRound(h);
    expect(h.commits).toHaveLength(0);
  });

  test("ends a round whose expiry was cut to the session's end with session_expired", async () => {
    const h = harness({
      open: async (now) => ({
        open: parseOpenResponse(openJson({ expires_in_ms: 6_000 })),
        startedAtMs: now,
      }),
    });
    await h.session.start(WALLET);
    const [timer] = h.pending();
    expect(timer!.delayMs).toBe(6_000);
    timer!.task();
    expect(h.failures).toEqual([{ reason: "session_expired" }]);
  });

  test("ignores a cue response that lands after abort", async () => {
    let release!: () => void;
    const h = harness({
      cue: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ point: { x: 200, y: 800 }, expiresInMs: 6_000, startedAtMs: OPENED_AT_MS });
        }),
    });
    await h.session.start(WALLET);
    await playRound(h);
    expect(h.phases.at(-1)).toBe("cue_loading");
    await h.session.abort();
    release();
    await h.flush();
    expect(h.session.currentRoundStatus).toBeNull();
    expect(h.cues).toEqual([]);
    expect(h.failures).toEqual([]);
    expect(h.commits).toHaveLength(0);
    expect(h.recorder().stopped).toBe(true);
  });

  test("ignores a cue response that lands after the round expired", async () => {
    let release!: () => void;
    const h = harness({
      cue: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ point: { x: 200, y: 800 }, expiresInMs: 6_000, startedAtMs: OPENED_AT_MS });
        }),
    });
    await h.session.start(WALLET);
    await playRound(h);
    expect(h.phases.at(-1)).toBe("cue_loading");
    // The round's twelve-second window closes while its cue response is lost.
    h.clock.now += 13_000;
    h.recorder().frames([QUIET]);
    expect(h.failures).toEqual([{ reason: "round_expired" }]);
    release();
    await h.flush();
    expect(h.cues).toEqual([]);
    expect(h.commits).toHaveLength(0);
    expect(h.phases.at(-1)).toBe("failed");
    expect(h.failures).toHaveLength(1);
  });

  test("refuses a reveal that has expired before display", async () => {
    const reveal = openJson().reveal as Record<string, unknown>;
    const h = harness({
      open: async (now) => ({
        open: parseOpenResponse(openJson({ reveal: { ...reveal, expires_in_ms: 0 } })),
        startedAtMs: now,
      }),
    });
    await h.session.start(WALLET);
    expect(h.pending()).toHaveLength(0);
    expect(h.reveals).toHaveLength(0);
    expect(h.failures).toEqual([{ reason: "round_expired" }]);
  });

  test("keeps the session end from each commit and cuts the next reveal to it", async () => {
    const h = harness({
      respond: async (commit) =>
        parseCommitResponse({ ...acceptJson(commit), session_expires_in_ms: 3_000 }, commit),
    });
    await h.session.start(WALLET);
    const [first] = h.pending();
    h.clock.now += 2_000;
    await playRound(h);
    // The commit may retry until the round's own expiry.
    expect(h.deadlines).toEqual([OPENED_AT_MS + 2_000 + 6_000]);
    expect(first!.cancelled).toBe(true);
    const [second] = h.pending();
    expect(second!.delayMs).toBe(3_000);
    second!.task();
    expect(h.failures).toEqual([{ reason: "session_expired" }]);
  });

  test("clears the round timer once the last round is committed and reports the session's end", async () => {
    const h = harness();
    await h.session.start(WALLET);
    await playRound(h);
    await playRound(h);
    await playRound(h);
    expect(h.completed).toHaveLength(1);
    expect(h.pending()).toEqual([]);
    expect(h.completed[0]!.sessionEndsAtMs).toBe(OPENED_AT_MS + 120_000);
  });
});

test("delivers the current frame classification to the meter", async () => {
  const run = harness();
  await run.session.start(WALLET);
  run.recorder().frames([...Array<number>(20).fill(0.001), 0.003, 0.02]);
  expect(run.levels.slice(-2)).toEqual([
    [0.003, false],
    [0.02, true],
  ]);
  await run.session.abort();
});
