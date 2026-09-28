// A paired verification's rounds: three rounds of one word and one short
// path, each committed before the server reveals the next.
//
// The server reveals round k + 1 only after it accepts the commitment for
// round k. That shows the client fixed its round evidence before it saw the
// next challenge. It does not prove capture time, sensor origin, human
// presence or physiological coupling.
//
// A round retains audio from reveal through the completed final trace. The
// server's committed cue is verified before the endpoint is displayed. Speech
// and tracing may happen in either order; Continue uses the same server checks.
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
  MAX_ROUND_SAMPLES,
  WAYPOINT_REACH,
  type PairedCue,
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
  expiresAtMs: number;
}

export type PairedPhase =
  | "opening"
  | "round"
  | "cue_loading"
  | "cue"
  | "committing"
  | "complete"
  | "failed";

/** The recorder surface the session needs. `startContinuousRecording` provides it. */
export interface PairedRecorder {
  readonly nativeSampleRate: number;
  readonly ready: Promise<void>;
  markNow(): number;
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
  cue(
    open: PairedOpenSession,
    reveal: PairedReveal,
    walletId: string,
    deadlineMs: number,
    signal: AbortSignal,
  ): Promise<PairedCue & { startedAtMs: number }>;
  commit(
    commit: PairedRoundCommit,
    deadlineMs: number,
    signal: AbortSignal,
  ): Promise<PairedCommitResponse & { startedAtMs: number }>;
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
  cue(view: { point: GridPoint; expiresAtMs: number }): void;
  phase(phase: PairedPhase): void;
  /** Whether the visible outline permits the speech fallback. */
  continueAvailable(available: boolean): void;
  /** Amplitude and tracker activity every 50 ms. Activity is false outside a round. */
  level(rms: number, speechActive: boolean): void;
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
  readonly currentRoundStatus: { speechReady: boolean; traceReady: boolean } | null;
  start(walletId: string): Promise<void>;
  /** One pressed-stroke sample: surface pixels and a `Date.now()` instant. */
  trace(sample: TraceSample, surface: TraceSurface): void;
  /** Requests the cue after speech. Returns whether the request started. */
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
  // Audio and classification both start at this round's reveal.
  let roundStart = 0;
  let roundStartedAtMs = 0;
  let trackerStart = 0;
  let roundTrace: TraceSample[] = [];
  let surface: TraceSurface | null = null;
  let pendingReaches: { timeMs: number; point: GridPoint }[] = [];
  let cuePoint: GridPoint | null = null;
  let cueRevealedAtMs = 0;
  let cueReached = false;
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
    const available = phase === "round" && completedOutline() !== null;
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
      for (const commit of commits) commit.segment.fill(0);
      commits.length = 0;
      roundTrace = [];
      pendingReaches = [];
      surface = null;
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

  const beginRound = (next: PairedReveal, startedAtMs: number): void => {
    if (!recorder) return;
    reveal = next;
    roundEndsAtMs = Math.min(startedAtMs + next.expiresInMs, sessionEndsAtMs);
    roundTrace = [];
    pendingReaches = [];
    if (deps.now() >= roundEndsAtMs) {
      end(() => listener.failure({ reason: "round_expired" }));
      return;
    }
    cuePoint = null;
    cueReached = false;
    roundStart = recorder.markNow();
    roundStartedAtMs = recorder.timeAt(roundStart);
    trackerStart = Math.ceil(roundStart / FRAME_SAMPLES) * FRAME_SAMPLES;
    recorder.releaseBefore(roundStart);
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
      expiresAtMs: roundEndsAtMs,
    });
  };

  const complete = async (): Promise<void> => {
    const active = recorder;
    if (!open || !active) return;
    disarm();
    setPhase("complete");
    const result: CompletedPairedRounds = {
      open,
      commits: commits.splice(0),
      walletId,
      audioStartedAtMs: audioStartedAtMs ?? audioEndedAtMs,
      audioEndedAtMs,
      sessionEndsAtMs,
      nativeSampleRate: active.nativeSampleRate,
    };
    recorder = null;
    await active.stop().catch(() => undefined);
    roundTrace = [];
    pendingReaches = [];
    surface = null;
    if (controller.signal.aborted) {
      for (const commit of result.commits) commit.segment.fill(0);
      result.commits.length = 0;
    } else listener.complete(result);
  };

  const commitRound = async (endedAtMs: number, outline: GridPoint[]): Promise<void> => {
    if (controller.signal.aborted) return;
    const active = recorder;
    const session = open;
    const round = reveal;
    const chained = previous;
    if (!active || !session || !round || !chained) {
      throw new Error("The paired session lost its state before a commit.");
    }
    const mark = active.sampleIndexAt(endedAtMs);
    const window: SampleWindow = { start: active.sampleIndexAt(roundStartedAtMs), end: mark };
    if (window.start >= mark || mark - window.start > MAX_ROUND_SAMPLES)
      throw new PairedServiceError({ reason: "evidence_bounds_invalid" });
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
    // Committed samples have been copied. Network waiting is excluded.
    active.releaseBefore(mark);
    roundTrace = [];

    let response: Awaited<ReturnType<PairedSessionDeps["commit"]>>;
    try {
      response = await deps.commit(commit, roundEndsAtMs, controller.signal);
    } finally {
      if (controller.signal.aborted) commit.segment.fill(0);
    }
    if (controller.signal.aborted) return;
    commits.push(commit);
    previous = commit.commitment;
    sessionEndsAtMs = Math.min(sessionEndsAtMs, response.startedAtMs + response.sessionExpiresInMs);
    if (response.reveal) beginRound(response.reveal, response.startedAtMs);
    else await complete();
  };

  const requestCue = async (): Promise<void> => {
    const session = open;
    const round = reveal;
    const active = recorder;
    if (phase !== "round" || !session || !round || !active) return;
    setPhase("cue_loading");
    refreshContinue();
    pendingReaches = [];
    const cue = await deps.cue(session, round, walletId, roundEndsAtMs, controller.signal);
    if (controller.signal.aborted || reveal !== round) return;
    roundEndsAtMs = Math.min(roundEndsAtMs, sessionEndsAtMs, cue.startedAtMs + cue.expiresInMs);
    if (deps.now() >= roundEndsAtMs) {
      end(() => listener.failure({ reason: "round_expired" }));
      return;
    }
    cuePoint = cue.point;
    cueRevealedAtMs = active.timeAt(active.markNow());
    reveal = { ...round, waypoints: [...round.waypoints, cue.point] };
    arm(roundEndsAtMs, "round_expired");
    setPhase("cue");
    listener.cue({ point: cue.point, expiresAtMs: roundEndsAtMs });
  };

  const finishRound = (mark: number, outline: GridPoint[]): void => {
    if (phase !== "cue" || mark <= roundStart || mark - roundStart > MAX_ROUND_SAMPLES) {
      end(() => listener.failure({ reason: "evidence_bounds_invalid" }));
      return;
    }
    const endedAtMs = recorder!.timeAt(mark);
    setPhase("committing");
    refreshContinue();
    // Leave the audio callback before hashing and posting.
    deps.defer(() => {
      commitRound(endedAtMs, outline).catch(fail);
    });
  };

  const onFrame = (level: number, endSample: number): void => {
    if (controller.signal.aborted) return;
    const active = phase === "round" || phase === "cue_loading" || phase === "cue";
    if (active && recorder) {
      roundStart = recorder.sampleIndexAt(roundStartedAtMs);
      const start = Math.ceil(roundStart / FRAME_SAMPLES) * FRAME_SAMPLES;
      if (phase === "round" && start > trackerStart)
        tracker.discardPrefix((start - trackerStart) / FRAME_SAMPLES);
      trackerStart = start;
    }
    if (active && endSample - roundStart > MAX_ROUND_SAMPLES) {
      end(() => listener.failure({ reason: "evidence_bounds_invalid" }));
      return;
    }
    if (active && deps.now() >= roundEndsAtMs) {
      end(() => listener.failure({ reason: "round_expired" }));
      return;
    }
    if (!active || phase === "cue_loading" || endSample <= trackerStart) {
      tracker.observe(level);
      listener.level(level, false);
      return;
    }
    const due = pendingReaches.filter(
      (reach) => recorder!.sampleIndexAt(reach.timeMs) <= endSample,
    );
    pendingReaches = pendingReaches.filter(
      (reach) => recorder!.sampleIndexAt(reach.timeMs) > endSample,
    );
    if (phase === "cue") {
      const point = cuePoint;
      if (
        point &&
        due.some(
          (reach) =>
            reach.timeMs >= cueRevealedAtMs &&
            Math.hypot(reach.point.x - point.x, reach.point.y - point.y) <= WAYPOINT_REACH,
        )
      )
        cueReached = true;
      listener.level(level, false);
      if (controller.signal.aborted) return;
      const outline = cueReached ? completedOutline() : null;
      if (outline) finishRound(endSample, outline);
      return;
    }
    for (const reach of due) tracker.reach(reach.point.x, reach.point.y);
    tracker.frame(level);
    listener.level(level, tracker.speechActive());
    if (controller.signal.aborted || phase !== "round") return;
    refreshContinue();
    if (tracker.speechReady() && completedOutline()) void requestCue().catch(fail);
  };

  const waitForRecorder = (active: PairedRecorder): Promise<void> =>
    new Promise((resolve, reject) => {
      const signal = controller.signal;
      const cleanup = () => {
        cancel();
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Recording cancelled."));
      };
      const cancel = deps.setTimer(onAbort, 15_000);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      active.ready.then(
        () => {
          cleanup();
          resolve();
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    });

  return {
    get currentRoundStatus() {
      if (phase !== "round" && phase !== "cue_loading" && phase !== "cue") return null;
      return {
        speechReady: tracker.speechReady(),
        traceReady: completedOutline() !== null,
      };
    },
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
        await waitForRecorder(started);
        if (controller.signal.aborted) return;
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
        sessionEndsAtMs = opened.startedAtMs + opened.open.expiresInMs;
        beginRound(opened.open.reveal, opened.startedAtMs);
      } catch (error) {
        fail(error);
      }
    },

    trace(sample, nextSurface) {
      if ((phase !== "round" && phase !== "cue") || !recorder) return;
      if (![sample.x, sample.y, sample.t].every(Number.isFinite)) return;
      surface = nextSurface;
      const last = roundTrace[roundTrace.length - 1];
      // A wall clock can step back. Repeating the last instant keeps the arrival
      // order, because the outline sorts by time and keeps ties in order.
      const t = last && sample.t < last.t ? last.t : sample.t;
      roundTrace.push({ x: sample.x, y: sample.y, t });
      pendingReaches.push({
        timeMs: t,
        point: toGridPoint(sample.x, sample.y, nextSurface),
      });
      if (phase === "round" && !continueShown) refreshContinue();
    },

    continueRound() {
      if (phase !== "round" || !recorder || deps.now() >= roundEndsAtMs) return false;
      if (!completedOutline()) {
        refreshContinue();
        return false;
      }
      void requestCue().catch(fail);
      return true;
    },

    async abort() {
      if (phase === "complete") {
        controller.abort();
        return;
      }
      phase = "failed";
      disarm();
      await release();
    },
  };
}
