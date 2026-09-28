import { resampleTo } from "@/sensor/resample";
import { createPairedSession, type PairedRecorder } from "../pairedSession";
import { startContinuousRecording } from "@/sensor/continuousAudio";
import type { NativePcmStreamOptions } from "@/sensor/audio";
import { encodePcm16, parseOpenResponse, type PairedRoundCommit } from "@/paired";
import type { PairedFailure } from "@/services/pairedErrors";
import { accept, openJson, roundEntry, WALLET } from "./pairedFixtures";

jest.mock("@/sensor/audio", () => ({ openNativePcmStream: jest.fn() }));

const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};

test("reconciles a delayed recorder clock at commit without losing early quiet speech", async () => {
  let wall = 10_296;
  let emit: NativePcmStreamOptions["onChunk"] = () => undefined;
  let recorder: PairedRecorder | undefined;
  const commits: PairedRoundCommit[] = [];
  const deferred: (() => void)[] = [];
  const slice = jest.fn();
  const session = createPairedSession(
    {
      startRecorder: async (onFrame) => {
        recorder = await startContinuousRecording({
          onFrame,
          now: () => wall,
          openStream: async (options) => {
            options.onConfigured?.(16_000);
            emit = options.onChunk;
            return { sampleRate: 16_000, failure: () => null, stop: async () => undefined };
          },
        });
        const original = recorder.slice.bind(recorder);
        recorder.slice = (start, end) => {
          slice(start, end);
          return original(start, end);
        };
        return recorder;
      },
      open: async () => {
        wall = 10_300;
        return { open: parseOpenResponse(openJson()), startedAtMs: 0 };
      },
      cue: async () => {
        const [x, y] = roundEntry(1).cuePoint;
        return { point: { x, y }, expiresInMs: 6000, startedAtMs: 0 };
      },
      commit: async (commit) => {
        commits.push(commit);
        return { ...accept(commit), startedAtMs: 0 };
      },
      now: () => 0,
      randomBytes: (length) => new Uint8Array(length).fill(9),
      defer: (task) => deferred.push(task),
      setTimer: () => () => undefined,
    },
    {
      reveal: () => undefined,
      cue: () => undefined,
      phase: () => undefined,
      continueAvailable: () => undefined,
      level: () => undefined,
      failure: (failure) => {
        throw new Error(JSON.stringify(failure));
      },
      unavailable: () => undefined,
      complete: () => undefined,
    },
  );
  const started = session.start(WALLET);
  await settle();
  emit(new Int16Array(4096));
  await started;
  wall = 10_522;
  const second = new Int16Array(4096);
  second.fill(164, 704, 2304); // Quiet pulse after the actual reveal.
  emit(second);
  const reveal = parseOpenResponse(openJson()).reveal;
  for (const point of reveal.waypoints)
    session.trace({ ...point, t: wall }, { width: 1000, height: 1000 });
  expect(session.continueRound()).toBe(true);
  await settle();
  wall += 1;
  const [x, y] = roundEntry(1).cuePoint;
  session.trace({ x, y, t: wall }, { width: 1000, height: 1000 });
  wall = 10_778;
  emit(new Int16Array(4096));
  expect(deferred).toHaveLength(1);
  // A further 5 ms refinement arrives before the deferred copy.
  wall = 11_029;
  emit(new Int16Array(4096));
  deferred.shift()!();
  await settle();
  expect(slice.mock.calls[0]).toEqual([4720, 8880]);
  expect(commits).toHaveLength(1);
  const pcm = commits[0]!.segment;
  const source = new Float32Array(4 * 4096);
  source.set(
    Float32Array.from(second, (value) => value / 32768),
    4096,
  );
  const canonical = await resampleTo(source, 16_000, 16_000);
  expect(pcm).toEqual(encodePcm16(canonical.subarray(4720, slice.mock.calls[0]![1] as number)));
  expect(pcm.some((value) => value !== 0)).toBe(true);
  await session.abort();
});

test("fails the round instead of committing a wrong window when the wall clock steps back", async () => {
  let wall = 10_296;
  let emit: NativePcmStreamOptions["onChunk"] = () => undefined;
  let stopped = 0;
  const failures: PairedFailure[] = [];
  const commits: PairedRoundCommit[] = [];
  const deferred: (() => void)[] = [];
  const session = createPairedSession(
    {
      startRecorder: async (onFrame) =>
        startContinuousRecording({
          onFrame,
          now: () => wall,
          openStream: async (options) => {
            options.onConfigured?.(16_000);
            emit = options.onChunk;
            return {
              sampleRate: 16_000,
              failure: () => null,
              stop: async () => {
                stopped++;
              },
            };
          },
        }),
      open: async () => {
        wall = 10_300;
        return { open: parseOpenResponse(openJson()), startedAtMs: 0 };
      },
      cue: async () => {
        const [x, y] = roundEntry(1).cuePoint;
        return { point: { x, y }, expiresInMs: 6000, startedAtMs: 0 };
      },
      commit: async (commit) => {
        commits.push(commit);
        return { ...accept(commit), startedAtMs: 0 };
      },
      now: () => 0,
      randomBytes: (length) => new Uint8Array(length).fill(9),
      defer: (task) => deferred.push(task),
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
  const started = session.start(WALLET);
  await settle();
  emit(new Int16Array(4096));
  await started;
  wall = 10_522;
  const pulse = new Int16Array(4096);
  pulse.fill(164, 704, 2304);
  emit(pulse);
  const reveal = parseOpenResponse(openJson()).reveal;
  for (const point of reveal.waypoints)
    session.trace({ ...point, t: wall }, { width: 1000, height: 1000 });
  expect(session.continueRound()).toBe(true);
  await settle();
  wall += 1;
  const [x, y] = roundEntry(1).cuePoint;
  session.trace({ x, y, t: wall }, { width: 1000, height: 1000 });
  wall = 10_778;
  emit(new Int16Array(4096));
  expect(deferred).toHaveLength(1);
  // The wall clock steps back 449 ms mid-round. The next arrival pulls the
  // recorder's origin estimate back with it, so the deferred window now maps
  // past the audio the recorder holds.
  wall = 10_329;
  emit(new Int16Array(4096));
  deferred.shift()!();
  await settle();
  expect(commits).toHaveLength(0);
  expect(failures).toHaveLength(1);
  expect(failures[0]!.detail).toMatch(/not held/);
  expect(stopped).toBe(1);
  await session.abort();
});
