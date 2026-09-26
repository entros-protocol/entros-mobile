import { FRAME_SAMPLES, frameRms } from "@/paired/tracker";

import type { NativePcmStreamOptions } from "../audio";
import { startContinuousRecording } from "../continuousAudio";
import { resampleTo } from "../resample";

// The recorder reads the native stream through an injected opener, so these
// tests never load react-native or the native audio module.
jest.mock("../audio", () => ({ openNativePcmStream: jest.fn() }));

interface FakeStream {
  options: NativePcmStreamOptions;
  stop: jest.Mock;
  emit(pcm: Int16Array): void;
}

function fakeOpener(sampleRate: number) {
  const holder: { stream: FakeStream | null } = { stream: null };
  const open = jest.fn(async (options: NativePcmStreamOptions) => {
    options.onConfigured?.(sampleRate);
    const stop = jest.fn(async () => undefined);
    holder.stream = { options, stop, emit: (pcm) => options.onChunk(pcm) };
    return { sampleRate, failure: () => null, stop };
  });
  return { open, holder };
}

function pcm(length: number, seed: number): Int16Array {
  const out = new Int16Array(length);
  let state = seed;
  for (let index = 0; index < length; index++) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    out[index] = Math.round(Math.sin(index / 7) * 9_000 + (state / 2_147_483_648 - 0.5) * 4_000);
  }
  return out;
}

function toFloat(samples: Int16Array): Float32Array {
  return Float32Array.from(samples, (sample) => sample / 32768);
}

describe("continuous recording", () => {
  test.each([16_000, 48_000])(
    "frames the canonical stream at %i Hz and slices it exactly",
    async (rate) => {
      const { open, holder } = fakeOpener(rate);
      const frames: [number, number][] = [];
      const recorder = await startContinuousRecording({
        onFrame: (level, end) => frames.push([level, end]),
        openStream: open,
        now: () => 1_000,
      });
      const source = pcm(rate * 2, rate);
      for (let offset = 0; offset < source.length; offset += 4_096) {
        holder.stream!.emit(source.subarray(offset, offset + 4_096));
      }
      const batch = await resampleTo(toFloat(source), rate, 16_000);
      const recorded = recorder.samplesRecorded();
      expect(recorded).toBeGreaterThan(batch.length - 400);
      expect(recorder.slice(0, recorded)).toEqual(batch.subarray(0, recorded));

      expect(frames).toHaveLength(Math.floor(recorded / FRAME_SAMPLES));
      frames.forEach(([level, end], index) => {
        expect(end).toBe((index + 1) * FRAME_SAMPLES);
        expect(level).toBe(frameRms(batch.subarray(end - FRAME_SAMPLES, end)));
      });
      expect(recorder.framedSamples()).toBe(frames.length * FRAME_SAMPLES);
      expect(recorder.nativeSampleRate).toBe(rate);
    },
    30_000,
  );

  test("releases audio before a mark and refuses slices of released audio", async () => {
    const { open, holder } = fakeOpener(16_000);
    const recorder = await startContinuousRecording({ onFrame: () => undefined, openStream: open });
    const source = pcm(32_000, 3);
    holder.stream!.emit(source);
    const kept = recorder.slice(8_000, 12_000);
    recorder.releaseBefore(8_000);
    expect(() => recorder.slice(7_999, 8_100)).toThrow(RangeError);
    expect(recorder.slice(8_000, 12_000)).toEqual(kept);
    holder.stream!.emit(pcm(4_096, 4));
    expect(recorder.slice(8_000, 12_000)).toEqual(kept);
    expect(() => recorder.slice(0, recorder.samplesRecorded() + 1)).toThrow(RangeError);
  });

  test("maps a wall-clock instant to a sample index from the least delayed chunk", async () => {
    const { open, holder } = fakeOpener(16_000);
    let clock = 0;
    const recorder = await startContinuousRecording({
      onFrame: () => undefined,
      openStream: open,
      now: () => clock,
    });
    expect(recorder.sampleIndexAt(123)).toBe(0);
    // 4,096 samples at 16 kHz span 256 ms. Recording started at 10_000 ms. The
    // first chunk lands 40 ms after its last sample, the second 10 ms after, so
    // the tightest bound places sample 0 at 10_010 ms.
    clock = 10_296;
    holder.stream!.emit(pcm(4_096, 1));
    expect(recorder.timeAt(0)).toBe(10_040);
    clock = 10_522;
    holder.stream!.emit(pcm(4_096, 2));
    expect(recorder.timeAt(0)).toBe(10_010);
    expect(recorder.sampleIndexAt(10_010)).toBe(0);
    expect(recorder.sampleIndexAt(10_110)).toBe(1_600);
    expect(recorder.timeAt(1_600)).toBe(10_110);
    expect(recorder.sampleIndexAt(9_000)).toBe(0);
  });

  test("reports a mid-session microphone failure and stops cleanly", async () => {
    const { open, holder } = fakeOpener(16_000);
    const onFailure = jest.fn();
    const recorder = await startContinuousRecording({
      onFrame: () => undefined,
      onFailure,
      openStream: open,
    });
    holder.stream!.options.onFailure?.(new Error("AudioRecord read failed (-3)"));
    expect(onFailure).toHaveBeenCalledWith(new Error("AudioRecord read failed (-3)"));
    await recorder.stop();
    await recorder.stop();
    expect(holder.stream!.stop).toHaveBeenCalledTimes(1);
    holder.stream!.emit(pcm(4_096, 5));
    expect(recorder.samplesRecorded()).toBe(0);
  });
});
