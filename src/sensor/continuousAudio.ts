// One continuous microphone recording for a paired session.
//
// The recorder canonicalises audio as it arrives and cuts it into 800-sample
// frames for the round tracker. Every position is a canonical sample index at
// 16 kHz, so a round's mark, its window and its segment refer to one clock.
// A round's audio is released once its segment is built, which bounds memory
// by one round.
//
// PRIVACY:
// - PCM stays in this module's buffer. `slice()` copies one round's window
//   for its segment. `releaseBefore()` and `stop()` drop everything else.
// - Nothing touches disk. The frame callback receives a level, never samples.

import { FRAME_SAMPLES, frameRms } from "@/paired/tracker";

import { openNativePcmStream, type NativePcmStream } from "./audio";
import {
  CANONICAL_SAMPLE_RATE,
  createStreamingCanonicalizer,
  type StreamingCanonicalizer,
} from "./resample";

/** One frame's RMS and the canonical sample index just past its end. */
export type FrameListener = (level: number, endSample: number) => void;

export interface ContinuousRecorder {
  /** The rate the native recorder delivers, before canonicalisation. */
  readonly nativeSampleRate: number;
  /** Canonical samples recorded so far. */
  samplesRecorded(): number;
  /** The end of the last whole frame the listener has seen. Marks fall here. */
  framedSamples(): number;
  /** The canonical sample index recorded at a wall-clock instant, in `Date.now()` ms. */
  sampleIndexAt(wallClockMs: number): number;
  /** The wall-clock instant, in `Date.now()` ms, of a canonical sample index. */
  timeAt(sampleIndex: number): number;
  /** A copy of canonical samples in `[start, end)`. Throws for audio already released. */
  slice(start: number, end: number): Float32Array;
  /** Releases audio before `sampleIndex`. */
  releaseBefore(sampleIndex: number): void;
  /** Stops the microphone and drops every held sample. */
  stop(): Promise<void>;
}

export interface ContinuousRecordingOptions {
  /** Runs for every whole frame. Keep it cheap: it runs inside the audio callback. */
  onFrame: FrameListener;
  /** Runs once if the microphone fails mid-session. */
  onFailure?: (error: Error) => void;
  /** Wall clock. Touch events carry the same clock, so a touch maps to a sample. */
  now?: () => number;
  /** Opens the native stream. Tests replace it. */
  openStream?: typeof openNativePcmStream;
}

const MS_PER_SECOND = 1_000;

export async function startContinuousRecording({
  onFrame,
  onFailure,
  now = Date.now,
  openStream = openNativePcmStream,
}: ContinuousRecordingOptions): Promise<ContinuousRecorder> {
  let canonicalizer: StreamingCanonicalizer | null = null;
  let nativeRate = 0;
  let nativeReceived = 0;
  // Wall-clock instant of native sample 0. A chunk arrives after its last
  // sample was captured, never before, so each arrival bounds this from above
  // and the smallest bound is the least delayed one.
  let originMs = Number.POSITIVE_INFINITY;

  let buffer = new Float32Array(CANONICAL_SAMPLE_RATE * 4);
  let bufferStart = 0;
  let total = 0;
  let framed = 0;
  let stopped = false;

  const append = (samples: Float32Array): void => {
    const used = total - bufferStart;
    if (used + samples.length > buffer.length) {
      const grown = new Float32Array(Math.max(buffer.length * 2, used + samples.length));
      grown.set(buffer.subarray(0, used));
      buffer = grown;
    }
    buffer.set(samples, used);
    total += samples.length;
    while (framed + FRAME_SAMPLES <= total) {
      const start = framed - bufferStart;
      const end = framed + FRAME_SAMPLES;
      const level = frameRms(buffer.subarray(start, start + FRAME_SAMPLES));
      framed = end;
      onFrame(level, end);
    }
  };

  const onChunk = (pcm: Int16Array): void => {
    if (stopped || !canonicalizer) return;
    const arrivedAt = now();
    nativeReceived += pcm.length;
    originMs = Math.min(originMs, arrivedAt - (nativeReceived * MS_PER_SECOND) / nativeRate);
    const source = new Float32Array(pcm.length);
    for (let index = 0; index < pcm.length; index++) source[index] = pcm[index]! / 32768;
    append(canonicalizer.push(source));
  };

  const stream: NativePcmStream = await openStream({
    onConfigured: (sampleRate) => {
      nativeRate = sampleRate;
      canonicalizer = createStreamingCanonicalizer(sampleRate);
    },
    onChunk,
    onFailure: (error) => {
      if (stopped) return;
      onFailure?.(error);
    },
  });

  return {
    nativeSampleRate: stream.sampleRate,
    samplesRecorded: () => total,
    framedSamples: () => framed,
    sampleIndexAt(wallClockMs) {
      if (!Number.isFinite(originMs)) return 0;
      const index = Math.round(((wallClockMs - originMs) * CANONICAL_SAMPLE_RATE) / MS_PER_SECOND);
      return Math.max(0, index);
    },
    timeAt(sampleIndex) {
      return originMs + (sampleIndex * MS_PER_SECOND) / CANONICAL_SAMPLE_RATE;
    },
    slice(start, end) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        throw new RangeError("A slice takes integer sample indices.");
      }
      if (start < bufferStart || end > total || start > end) {
        throw new RangeError(`Samples ${start} to ${end} are not held.`);
      }
      return buffer.slice(start - bufferStart, end - bufferStart);
    },
    releaseBefore(sampleIndex) {
      const discard = Math.min(sampleIndex, total) - bufferStart;
      if (discard <= 0) return;
      buffer.copyWithin(0, discard, total - bufferStart);
      buffer.fill(0, total - bufferStart - discard, total - bufferStart);
      bufferStart += discard;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await stream.stop();
      } finally {
        buffer = new Float32Array(0);
        bufferStart = total;
        canonicalizer = null;
      }
    },
  };
}
