// A paired verification's rounds: three rounds of one word and one short
// path, each committed before the server reveals the next.
//
// The server reveals round k + 1 only after it accepts the commitment for
// round k. That shows the client fixed its round evidence before it saw the
// next challenge. It does not prove capture time, sensor origin, human
// presence or physiological coupling.
//
// Recording runs without a break for the whole session. A round ends when the
// tracker hears speech after the trace has reached every waypoint in order,
// and the round's outline passes the rule the server applies to it. A round
// that stalls may end by hand, under the same outline rule. Its segment is
// final at that mark: the window is cut from the canonical stream, encoded,
// hashed and committed. The server bounds each round and the session in time,
// and the session ends when either bound passes. Nothing on screen counts
// down.
//
// PRIVACY: the pressed-stroke samples for each round stay in memory until its
// coarse path is built. Segment audio leaves the device only in the finalize
// request, which the processing screen sends.

import {
  buildCommitBody,
  CoarsePathError,
  createRoundTracker,
  encodeCoarsePath,
  encodePcm16,
  FRAME_SAMPLES,
  initialCommitment,
  PAIRED_ROUNDS,
  roundWindow,
  scorePath,
  toCoarsePath,
  toGridPoint,
  type GridPoint,
  type PairedCommitResponse,
  type PairedOpenSession,
  type PairedReveal,
  type PairedRoundCommit,
  type SampleWindow,
  type TraceSample,
  type TraceSurface,
} from "@/paired";
import { PairedServiceError, type PairedFailure } from "@/services/pairedErrors";
import type { OpenedPairedSession } from "@/services/pairedExecutor";

/** What the rounds screen shows for one round. */
export interface PairedRoundView {
  roundIndex: number;
  rounds: number;
  word: string;
  /** Waypoints on the 0 to 1000 grid of the trace surface, in order. */
  waypoints: GridPoint[];
}

export type PairedPhase = "opening" | "round" | "committing" | "complete" | "failed";

/** The recorder surface the session needs. `startContinuousRecording` provides it. */
export interface PairedRecorder {
  readonly nativeSampleRate: number;
  framedSamples(): number;
  sampleIndexAt(wallClockMs: number): number;
  timeAt(sampleIndex: number): number;
  slice(start: number, end: number): Float32Array;
  releaseBefore(sampleIndex: number): void;
  stop(): Promise<void>;
}

export interface PairedSessionDeps {
  startRecorder(
    onFrame: (level: number, endSample: number) => void,
    onFailure: (error: Error) => void,
  ): Promise<PairedRecorder>;
  open(walletId: string, signal: AbortSignal): Promise<OpenedPairedSession>;
  commit(
    commit: PairedRoundCommit,
    deadlineMs: number,
    signal: AbortSignal,
  ): Promise<PairedCommitResponse>;
  /** Monotonic clock for server deadlines, the same one `open` reports against. */
  now(): number;
  randomBytes(length: number): Uint8Array;
  /** Runs a task after the current callback returns. */
  defer(task: () => void): void;
  /** Runs `task` after `delayMs`. Returns a function that cancels it. */
  setTimer(task: () => void, delayMs: number): () => void;
}

export interface PairedSessionListener {
  reveal(view: PairedRoundView): void;
  phase(phase: PairedPhase): void;
  /** Whether the stalled round may end by hand. */
  continueAvailable(available: boolean): void;
  /** One level per 50 ms frame, for a live meter. */
  level(rms: number): void;
  failure(failure: PairedFailure): void;
  /** The relayer offers no paired sessions. The host falls back to the single capture. */
  unavailable(): void;
  complete(result: CompletedPairedRounds): void;
}

/** A session whose three rounds the server accepted. */
export interface CompletedPairedRounds {
  open: PairedOpenSession;
  commits: PairedRoundCommit[];
  walletId: string;
  /** Wall-clock span, in `Date.now()` ms, from the first committed sample to the last mark. */
  audioStartedAtMs: number;
  audioEndedAtMs: number;
  /** When the window to finalize in closes, on the `now` clock. */
  sessionEndsAtMs: number;
  nativeSampleRate: number;
}

export interface PairedSessionController {
  start(walletId: string): Promise<void>;
  /** One pressed-stroke sample: surface pixels and a `Date.now()` instant. */
  trace(sample: TraceSample, surface: TraceSurface): void;
  /** Ends a stalled round by hand. Returns whether the round ended. */
  continueRound(): boolean;
  /** Stops every sensor and ends the session without reporting. */
  abort(): Promise<void>;
}

const IDEMPOTENCY_KEY_BYTES = 16;

function failureOf(error: unknown): PairedFailure {
  if (error instanceof PairedServiceError) return error.failure;
  if (error instanceof CoarsePathError) {
    return { reason: "evidence_bounds_invalid", detail: error.reason };
  }
  return { detail: error instanceof Error ? error.message : String(error) };
}

export function createPairedSession(
  deps: PairedSessionDeps,
  listener: PairedSessionListener,
): PairedSessionController {
  const tracker = createRoundTracker();
  const controller = new AbortController();
  const commits: PairedRoundCommit[] = [];

  let phase: PairedPhase = "opening";
  let recorder: PairedRecorder | null = null;
  let open: PairedOpenSession | null = null;
  let reveal: PairedReveal | null = null;
  let previous: Uint8Array | null = null;
  let walletId = "";
  /** When the current round expires, on the `now` clock, never past the session's end. */
  let roundEndsAtMs = 0;
  /** When the session ends unless the client acts, on the `now` clock, as the server last said. */
  let sessionEndsAtMs = 0;
  let cancelTimer: (() => void) | null = null;
  // The window a round commits starts at the previous mark. The tracker's
  // frames for the round start where it began, after the reveal arrived.
  let roundStart = 0;
  let trackerStart = 0;
  let roundTrace: TraceSample[] = [];
  let surface: TraceSurface | null = null;
  let pendingReaches: { sample: number; point: GridPoint }[] = [];
  let stalled = false;
  let continueShown = false;
  let audioStartedAtMs: number | null = null;
  let audioEndedAtMs = 0;

  const setPhase = (next: PairedPhase): void => {
    phase = next;
    listener.phase(next);
  };

  const disarm = (): void => {
    cancelTimer?.();
    cancelTimer = null;
  };

  /** The round's outline, when it reaches every waypoint in order by the server's rule. */
  const completedOutline = (): GridPoint[] | null => {
    if (!surface || !reveal) return null;
    let outline: GridPoint[];
    try {
      outline = toCoarsePath(roundTrace, surface);
    } catch (error) {
      if (error instanceof CoarsePathError) return null;
      throw error;
    }
    return scorePath(reveal.waypoints, outline).inOrder ? outline : null;
  };

  const refreshContinue = (): void => {
    const available = phase === "round" && stalled && completedOutline() !== null;
    if (available !== continueShown) {
      continueShown = available;
      listener.continueAvailable(available);
    }
  };

  let released: Promise<void> | null = null;
  /** Stops the recorder once. Every call returns the same promise, so callers await one stop. */
  const release = (): Promise<void> => {
    released ??= (async () => {
      controller.abort();
      const active = recorder;
      recorder = null;
      await active?.stop().catch(() => undefined);
    })();
    return released;
  };

  /** Ends the session once and tells the listener why. */
  const end = (notify: () => void): void => {
    if (phase === "failed" || phase === "complete") return;
    if (controller.signal.aborted) return;
    setPhase("failed");
    disarm();
    refreshContinue();
    void release();
    notify();
  };

  const fail = (error: unknown): void => end(() => listener.failure(failureOf(error)));

  /** Ends the session with `reason` at `atMs` on the `now` clock unless it ends first. */
  const arm = (atMs: number, reason: "round_expired" | "session_expired"): void => {
    disarm();
    cancelTimer = deps.setTimer(
      () => {
        cancelTimer = null;
        end(() => listener.failure({ reason }));
      },
      Math.max(0, atMs - deps.now()),
    );
  };

  const beginRound = (next: PairedReveal, receivedAtMs: number): void => {
    if (!recorder) return;
    reveal = next;
    roundEndsAtMs = Math.min(receivedAtMs + next.expiresInMs, sessionEndsAtMs);
    roundTrace = [];
    pendingReaches = [];
    stalled = false;
    trackerStart = recorder.framedSamples();
    if (next.roundIndex === 1) {
      roundStart = trackerStart;
      recorder.releaseBefore(roundStart);
    }
    tracker.begin(next.waypoints, true);
    // A round whose expiry was cut to the session's end fails as the session.
    arm(roundEndsAtMs, roundEndsAtMs < sessionEndsAtMs ? "round_expired" : "session_expired");
    setPhase("round");
    refreshContinue();
    listener.reveal({
      roundIndex: next.roundIndex,
      rounds: PAIRED_ROUNDS,
      word: next.word,
      waypoints: next.waypoints.map((point) => ({ x: point.x, y: point.y })),
    });
  };

  const complete = async (): Promise<void> => {
    const active = recorder;
    if (!open || !active) return;
    disarm();
    setPhase("complete");
    const result: CompletedPairedRounds = {
      open,
      commits: [...commits],
      walletId,
      audioStartedAtMs: audioStartedAtMs ?? audioEndedAtMs,
      audioEndedAtMs,
      sessionEndsAtMs,
      nativeSampleRate: active.nativeSampleRate,
    };
    recorder = null;
    await active.stop().catch(() => undefined);
    listener.complete(result);
  };

  const commitRound = async (
    mark: number,
    window: SampleWindow,
    outline: GridPoint[],
  ): Promise<void> => {
    const active = recorder;
    const session = open;
    const round = reveal;
    const chained = previous;
    if (!active || !session || !round || !chained) {
      throw new Error("The paired session lost its state before a commit.");
    }
    const segment = encodePcm16(active.slice(window.start, window.end));
    const coarsePath = encodeCoarsePath(session.tier, outline);
    const commit = buildCommitBody({
      open: session,
      reveal: round,
      walletId,
      previousCommitment: chained,
      segment,
      coarsePath,
      pointCount: outline.length,
      idempotencyKey: deps.randomBytes(IDEMPOTENCY_KEY_BYTES),
    });
    audioStartedAtMs ??= active.timeAt(window.start);
    audioEndedAtMs = active.timeAt(mark);
    // The next round's audio starts at this mark. Nothing before it is needed.
    active.releaseBefore(mark);
    roundStart = mark;
    roundTrace = [];

    const response = await deps.commit(commit, roundEndsAtMs, controller.signal);
    if (controller.signal.aborted) return;
    const receivedAtMs = deps.now();
    commits.push(commit);
    previous = commit.commitment;
    sessionEndsAtMs = receivedAtMs + response.sessionExpiresInMs;
    if (response.reveal) beginRound(response.reveal, receivedAtMs);
    else await complete();
  };

  const finishRound = (mark: number, outline: GridPoint[]): void => {
    let window: SampleWindow;
    try {
      // Fixed at the mark: frames heard after it move the noise floor, and with
      // it the runs, but belong to the next round.
      const runs = tracker
        .runs()
        .filter((run) => run.qualifies)
        .map(
          (run) =>
            [
              trackerStart + run.startFrame * FRAME_SAMPLES,
              trackerStart + run.endFrame * FRAME_SAMPLES,
            ] as const,
        );
      window = roundWindow(roundStart, mark, runs);
    } catch (error) {
      fail(error);
      return;
    }
    setPhase("committing");
    refreshContinue();
    // Leave the audio callback before hashing and posting.
    deps.defer(() => {
      commitRound(mark, window, outline).catch(fail);
    });
  };

  const onFrame = (level: number, endSample: number): void => {
    if (controller.signal.aborted) return;
    listener.level(level);
    if (phase !== "round") {
      tracker.observe(level);
      return;
    }
    const due = pendingReaches.filter((reach) => reach.sample <= endSample);
    if (due.length > 0) {
      pendingReaches = pendingReaches.filter((reach) => reach.sample > endSample);
      for (const reach of due) tracker.reach(reach.point.x, reach.point.y);
    }
    const decision = tracker.frame(level);
    // The server scores the committed outline, so a round ends only on an
    // outline that passes. Otherwise it waits like a stalled round.
    const outline = decision === "complete" ? completedOutline() : null;
    if (outline) {
      finishRound(endSample, outline);
    } else if (decision !== "open" && !stalled) {
      stalled = true;
      refreshContinue();
    }
  };

  return {
    async start(wallet) {
      if (phase !== "opening" || recorder) throw new Error("This paired session has started.");
      walletId = wallet;
      try {
        // The recorder starts first, so the tracker learns the room's floor
        // while the session opens.
        const started = await deps.startRecorder(onFrame, (error) => fail(error));
        // `abort()` may have run while the microphone started, before there was one to stop.
        if (controller.signal.aborted) {
          await started.stop().catch(() => undefined);
          return;
        }
        recorder = started;
        let opened: OpenedPairedSession;
        try {
          opened = await deps.open(wallet, controller.signal);
        } catch (error) {
          if (error instanceof PairedServiceError && error.failure.status === 404) {
            end(() => listener.unavailable());
            return;
          }
          throw error;
        }
        if (controller.signal.aborted) return;
        open = opened.open;
        previous = initialCommitment(opened.open);
        sessionEndsAtMs = opened.receivedAtMs + opened.open.expiresInMs;
        beginRound(opened.open.reveal, opened.receivedAtMs);
      } catch (error) {
        fail(error);
      }
    },

    trace(sample, nextSurface) {
      if (phase !== "round" || !recorder) return;
      if (![sample.x, sample.y, sample.t].every(Number.isFinite)) return;
      surface = nextSurface;
      const last = roundTrace[roundTrace.length - 1];
      // A wall clock can step back. Repeating the last instant keeps the arrival
      // order, because the outline sorts by time and keeps ties in order.
      const t = last && sample.t < last.t ? last.t : sample.t;
      roundTrace.push({ x: sample.x, y: sample.y, t });
      pendingReaches.push({
        sample: recorder.sampleIndexAt(t),
        point: toGridPoint(sample.x, sample.y, nextSurface),
      });
      // Checking again once Continue shows would rebuild the outline on every
      // sample. The press checks the outline itself.
      if (stalled && !continueShown) refreshContinue();
    },

    continueRound() {
      if (phase !== "round" || !stalled || !recorder) return false;
      const outline = completedOutline();
      if (!outline) {
        refreshContinue();
        return false;
      }
      finishRound(recorder.framedSamples(), outline);
      return true;
    },

    async abort() {
      if (phase === "complete") return;
      phase = "failed";
      disarm();
      await release();
    },
  };
}
