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
} from "../pairedSession";

import { accept, acceptJson, openJson, WALLET } from "./pairedFixtures";

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
}

function harness(options: HarnessOptions = {}) {
  let recorder: FakeRecorder | null = null;
  const deferred: (() => void)[] = [];
  const timers: FakeTimer[] = [];
  const clock = { now: OPENED_AT_MS };
  const state = {
    commits: [] as PairedRoundCommit[],
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
          ? async () => ({ open: parseOpenResponse(openJson()), receivedAtMs: clock.now })
          : () => options.open!(clock.now),
      commit: async (commit, deadlineMs) => {
        state.commits.push(commit);
        state.deadlines.push(deadlineMs);
        return respond(commit);
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
      phase: (phase) => state.phases.push(phase),
      continueAvailable: (available) => state.continueStates.push(available),
      level: () => undefined,
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
  await h.flush();
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

    // Round 1 starts where the tracker began. Each later round starts at the
    // previous mark, so the three windows join without a gap.
    const lengths = h.commits.map((commit) => commit.segment.length / 2);
    expect(lengths.every((length) => length % FRAME_SAMPLES === 0)).toBe(true);
    const result = h.completed[0]!;
    expect(result.audioStartedAtMs).toBe(openedAt / SAMPLES_PER_MS);
    expect(result.audioEndedAtMs - result.audioStartedAtMs).toBe(
      lengths.reduce((sum, length) => sum + length, 0) / SAMPLES_PER_MS,
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
        return [QUIET, QUIET, ...SPOKEN][frame]!;
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
    const outline = toCoarsePath(trace, SURFACE);
    expect(scorePath(view.waypoints, outline).inOrder).toBe(true);
    expect(bytesToHex(h.commits[0]!.coarsePath)).toBe(
      bytesToHex(encodeCoarsePath("trace", outline)),
    );
    expect(h.commits[0]!.body.path_point_count).toBe(outline.length);
  });

  test("keeps a late word when a long round is trimmed, measuring runs from the tracker's start", async () => {
    let release: (() => void) | null = null;
    const h = harness({
      respond: async (commit) => {
        if (commit.body.round_index === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return accept(commit);
      },
    });
    await h.session.start(WALLET);
    await playRound(h);
    const mark = h.recorder().framedSamples() - 2 * FRAME_SAMPLES;
    // 100 frames pass between round 1's mark and round 2's reveal. They belong
    // to round 2's window but precede its tracker frames.
    h.recorder().frames(Array(100).fill(QUIET));
    release!();
    await h.flush();
    const view = h.reveals[1]!;
    const trackerStart = h.recorder().framedSamples();
    h.recorder().frames([...Array(250).fill(QUIET), ...Array(6).fill(VOICED)]);
    traceGrid(h, view.waypoints);
    h.recorder().frames(Array(14).fill(QUIET));
    await h.flush();

    const segment = decodePcm16(h.commits[1]!.segment);
    expect(segment).toHaveLength(MAX_ROUND_SAMPLES);
    const roundEnd = trackerStart + 256 * FRAME_SAMPLES + 12 * FRAME_SAMPLES;
    expect(roundEnd - mark).toBeGreaterThan(MAX_ROUND_SAMPLES);
    // The window ends at the round end, 600 ms after the word, and holds it.
    const windowStart = roundEnd - MAX_ROUND_SAMPLES;
    const wordStart = trackerStart + 250 * FRAME_SAMPLES - windowStart;
    expect(segment[wordStart - 1]).toBeCloseTo(QUIET, 3);
    expect(segment[wordStart]).toBeCloseTo(VOICED, 3);
    expect(segment[wordStart + 6 * FRAME_SAMPLES - 1]).toBeCloseTo(VOICED, 3);
  });

  test("offers Continue only after a stall and only with a trace that passes", async () => {
    const h = harness();
    await h.session.start(WALLET);
    const view = h.reveals[0]!;
    // No speech: the trace completes, then the tracker stalls after 80 frames.
    h.recorder().frames(Array(10).fill(QUIET));
    expect(h.session.continueRound()).toBe(false);
    traceGrid(h, view.waypoints);
    h.recorder().frames(Array(79).fill(QUIET));
    expect(h.continueStates).toEqual([]);
    h.recorder().frames(Array(10).fill(QUIET));
    expect(h.continueStates).toEqual([true]);
    expect(h.session.continueRound()).toBe(true);
    await h.flush();
    expect(h.commits).toHaveLength(1);
    expect(h.continueStates).toEqual([true, false]);
    expect(h.reveals).toHaveLength(2);
  });

  test("waits for a trace that forms a path before it ends a round", async () => {
    const h = harness();
    await h.session.start(WALLET);
    const view = h.reveals[0]!;
    // Pressed at the first point only: the trace has no length.
    traceGrid(h, [view.waypoints[0]!, view.waypoints[0]!]);
    h.recorder().frames([QUIET, QUIET, ...SPOKEN, ...Array(300).fill(QUIET)]);
    await h.flush();
    expect(h.commits).toHaveLength(0);
    expect(h.phases.at(-1)).toBe("round");
    expect(h.continueStates).toEqual([]);
    expect(h.session.continueRound()).toBe(false);

    traceGrid(h, view.waypoints.slice(1));
    expect(h.continueStates).toEqual([true]);
    expect(h.session.continueRound()).toBe(true);
    await h.flush();
    expect(h.commits).toHaveLength(1);
  });

  test("counts waypoints only in the issued order", async () => {
    const h = harness();
    await h.session.start(WALLET);
    const view = h.reveals[0]!;
    traceGrid(h, [...view.waypoints].reverse());
    h.recorder().frames([QUIET, QUIET, ...SPOKEN, ...Array(300).fill(QUIET)]);
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
        commit: async (commit) => accept(commit),
        now: () => 0,
        randomBytes: (length) => new Uint8Array(length),
        defer: (task) => task(),
        setTimer: () => () => undefined,
      },
      {
        reveal: () => undefined,
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
    expect(timer!.delayMs).toBe(120_000);
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
        open: parseOpenResponse(openJson({ expires_in_ms: 60_000 })),
        receivedAtMs: now,
      }),
    });
    await h.session.start(WALLET);
    const [timer] = h.pending();
    expect(timer!.delayMs).toBe(60_000);
    timer!.task();
    expect(h.failures).toEqual([{ reason: "session_expired" }]);
  });

  test("accepts a reveal that expires at once", async () => {
    const reveal = openJson().reveal as Record<string, unknown>;
    const h = harness({
      open: async (now) => ({
        open: parseOpenResponse(openJson({ reveal: { ...reveal, expires_in_ms: 0 } })),
        receivedAtMs: now,
      }),
    });
    await h.session.start(WALLET);
    const [timer] = h.pending();
    expect(timer!.delayMs).toBe(0);
    timer!.task();
    expect(h.failures).toEqual([{ reason: "round_expired" }]);
  });

  test("keeps the session end from each commit and cuts the next reveal to it", async () => {
    const h = harness({
      respond: async (commit) =>
        parseCommitResponse({ ...acceptJson(commit), session_expires_in_ms: 30_000 }, commit),
    });
    await h.session.start(WALLET);
    const [first] = h.pending();
    h.clock.now += 2_000;
    await playRound(h);
    // The commit may retry until the round's own expiry.
    expect(h.deadlines).toEqual([OPENED_AT_MS + 120_000]);
    expect(first!.cancelled).toBe(true);
    const [second] = h.pending();
    expect(second!.delayMs).toBe(30_000);
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
    expect(h.completed[0]!.sessionEndsAtMs).toBe(OPENED_AT_MS + 590_000);
  });
});
