// Round segments and the analysis signal.
//
// Each round commits PCM16 bytes cut from the canonical 16 kHz stream. Committed bytes can
// never change, so the analysis signal is rebuilt from those bytes, never from float
// buffers: decode every segment, join them with no separator, and level the joined signal
// once. The server builds the same signal from the same bytes.

import { normalizeCaptureRMS } from "@/sensor/audioNormalization";

import { MAX_ROUND_SAMPLES } from "./transcript";

/** Audio kept after the chosen voiced run when a long round is trimmed, 600 ms. */
export const TRIM_TAIL_SAMPLES = 9_600;

/** A half-open window `[start, end)` on the canonical sample clock. */
export interface SampleWindow {
  start: number;
  end: number;
}

function assertSampleIndex(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer sample index.`);
  }
}

/**
 * The window a round commits. A round within the bound keeps every sample. A longer round
 * keeps the bounded window that covers the most voiced audio, each candidate ending 600 ms
 * after a voiced run, and equal coverage goes to the later candidate. A round with no voiced
 * run keeps its tail. The bound exists for resources, so the rule's only job is to keep the
 * spoken word.
 *
 * `voicedRuns` are `[start, end)` sample ranges of the round's qualifying runs, in order.
 */
export function roundWindow(
  roundStart: number,
  roundEnd: number,
  voicedRuns: readonly (readonly [number, number])[],
): SampleWindow {
  assertSampleIndex(roundStart, "roundStart");
  assertSampleIndex(roundEnd, "roundEnd");
  if (roundEnd < roundStart) throw new RangeError("roundEnd precedes roundStart.");
  if (roundEnd - roundStart <= MAX_ROUND_SAMPLES) return { start: roundStart, end: roundEnd };

  let best: { covered: number; window: SampleWindow } | null = null;
  for (const [, runEnd] of voicedRuns) {
    const anchor = Math.min(roundEnd, runEnd + TRIM_TAIL_SAMPLES);
    const window =
      anchor - MAX_ROUND_SAMPLES < roundStart
        ? { start: roundStart, end: roundStart + MAX_ROUND_SAMPLES }
        : { start: anchor - MAX_ROUND_SAMPLES, end: anchor };
    let covered = 0;
    for (const [runStart, otherEnd] of voicedRuns) {
      covered += Math.max(0, Math.min(window.end, otherEnd) - Math.max(window.start, runStart));
    }
    if (best === null || covered >= best.covered) best = { covered, window };
  }
  return best ? best.window : { start: roundEnd - MAX_ROUND_SAMPLES, end: roundEnd };
}

/** Float samples to PCM16 little-endian. Negatives scale by 32768 and positives by 32767,
 *  and `Math.round` sends ties toward positive infinity. Matches the single-capture wire. */
export function encodePcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < samples.length; index++) {
    const sample = Math.max(-1, Math.min(1, samples[index]!));
    const value = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(index * 2, value, true);
  }
  return out;
}

/** PCM16 little-endian to float samples, dividing by 32768. */
export function decodePcm16(bytes: Uint8Array): Float32Array {
  if (bytes.length % 2 !== 0) throw new RangeError("PCM16 audio has an even byte length.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = view.getInt16(index * 2, true) / 0x8000;
  }
  return out;
}

export interface AnalysisSignal {
  /** The committed segments decoded and joined in round order, before levelling. */
  joined: Float32Array;
  /** `normalizeCaptureRMS(joined)`, the signal every check reads. */
  signal: Float32Array;
}

/**
 * Decodes the committed segments once, joins them with no separator and levels the join once.
 * `signal` can be `joined` itself when the join is too quiet to level.
 */
export function analysisSignal(segments: readonly Uint8Array[]): AnalysisSignal {
  let byteLength = 0;
  for (const segment of segments) {
    if (segment.length % 2 !== 0) throw new RangeError("PCM16 audio has an even byte length.");
    byteLength += segment.length;
  }
  const joined = new Float32Array(byteLength / 2);
  let offset = 0;
  for (const segment of segments) {
    const decoded = decodePcm16(segment);
    joined.set(decoded, offset);
    offset += decoded.length;
  }
  return { joined, signal: normalizeCaptureRMS(joined) };
}
