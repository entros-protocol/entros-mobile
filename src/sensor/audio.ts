// Audio capture via react-native-live-audio-stream. Streams raw 16-bit PCM
// chunks at 16 kHz mono — the exact equivalent of the browser flow's
// `getUserMedia({ sampleRate: 16000, channelCount: 1, ... })` plus
// ScriptProcessorNode pattern, so SimHash commitments are bit-reproducible
// across web and mobile.
//
// PRIVACY:
// - PCM samples accumulate in a single Float32Array held in this module's
//   closure. The buffer is handed to the caller in `stop()` and the closure
//   reference is cleared.
// - Nothing touches disk: there's no recording file. The library streams
//   chunks directly into JS memory.
// - The level callback receives RMS computed from the chunk; the chunk
//   itself is never logged.
// - Caller MUST discard the returned Float32Array after feature extraction.

import type { EmitterSubscription } from "react-native";
import { PermissionsAndroid, Platform } from "react-native";

import { AudioCapture, TARGET_AUDIO_SAMPLE_RATE } from "./types";

// `react-native-live-audio-stream` ships an .d.ts that marks `wavFile`
// required (it's optional at runtime — we never write to disk) and types
// `on()` as returning void (it returns an EmitterSubscription). We restate
// the runtime shape here so the rest of this file is fully type-checked.
interface AudioRecordOptions {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  audioSource?: number;
  bufferSize?: number;
}

interface IAudioRecord {
  init(options: AudioRecordOptions): void;
  start(): void;
  // Resolves once the patched native module has stopped + released its
  // AudioRecord (see `patches/react-native-live-audio-stream+1.1.1.patch`).
  // The unpatched upstream never resolves this Promise — we treat it as
  // fire-and-forget regardless to be safe across both shapes.
  stop(): Promise<unknown>;
  on(event: "data", callback: (data: string) => void): EmitterSubscription;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const LiveAudioStream = require("react-native-live-audio-stream").default as IAudioRecord;

export interface AudioRecorder {
  stop: () => Promise<AudioCapture>;
  cancel: () => Promise<void>;
}

// MediaRecorder.AudioSource constants — we use MIC (1) for the rawest input.
// VOICE_RECOGNITION (6) applies AGC + noise suppression, which would change
// the feature distribution and break cross-platform reproducibility.
const ANDROID_AUDIO_SOURCE_MIC = 1;

const STREAM_OPTIONS = {
  sampleRate: TARGET_AUDIO_SAMPLE_RATE,
  channels: 1,
  bitsPerSample: 16,
  audioSource: ANDROID_AUDIO_SOURCE_MIC,
  // bufferSize is in BYTES per the library contract. 8192 bytes = 4096
  // Int16 samples = 256ms hop at 16kHz, matching the browser's
  // ScriptProcessorNode(4096) buffer exactly so chunk cadence aligns.
  bufferSize: 8192,
} as const;

// 1.5 second worst-case wait for the first PCM chunk to land. On a real
// device with a working mic, the first chunk lands ~256ms after start().
// On an emulator with no virtual mic routing, no chunks ever arrive — we
// surface that as a friendly error instead of letting the screen sit with
// flat sensor bars for 12 seconds.
const FIRST_CHUNK_TIMEOUT_MS = 1500;

let recordingActive = false;

// `PermissionsAndroid.PERMISSIONS` has an index signature under React Native's
// type defs, so under `noUncheckedIndexedAccess` each constant is `Permission |
// undefined`. RECORD_AUDIO is a platform-defined constant that is always
// present, so a non-null assertion is sound here.
const RECORD_AUDIO = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO!;

export const requestAudioPermission = async (): Promise<boolean> => {
  if (Platform.OS === "android") {
    const result = await PermissionsAndroid.request(RECORD_AUDIO, {
      title: "Microphone access",
      message:
        "Entros records a short voice sample for behavioural analysis on this device. Audio is processed locally and discarded immediately.",
      buttonPositive: "Allow",
      buttonNegative: "Deny",
    });
    return result === PermissionsAndroid.RESULTS.GRANTED;
  }
  // iOS prompts on first AVAudioRecorder access; we trust Info.plist
  // NSMicrophoneUsageDescription to drive that flow when capture starts.
  return true;
};

export const audioPermissionGranted = async (): Promise<boolean> => {
  if (Platform.OS === "android") {
    return PermissionsAndroid.check(RECORD_AUDIO);
  }
  return true;
};

const decodeBase64Pcm = (b64: string): Int16Array => {
  const bin = atob(b64);
  const len = bin.length;
  const buf = new ArrayBuffer(len);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  // The native side emits little-endian Int16 PCM. Wrap the same buffer with
  // an Int16Array view — zero copy.
  return new Int16Array(buf, 0, len >> 1);
};

const computeRmsInt16 = (samples: Int16Array): number => {
  let sum = 0;
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const s = samples[i]! / 32768;
    sum += s * s;
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
};

export const startAudioRecording = async (
  onLevel?: (rms: number) => void,
): Promise<AudioRecorder> => {
  if (recordingActive) {
    throw new Error("Audio recording already in progress.");
  }
  recordingActive = true;

  // Buffer of Int16 chunks; deferred concatenation in stop() avoids per-chunk
  // realloc + copy. ~9 chunks/sec × 12s × 8KB = ~864KB total — easy to hold.
  const chunks: Int16Array[] = [];
  let totalSamples = 0;
  const startedAt = Date.now();
  let stopped = false;

  LiveAudioStream.init(STREAM_OPTIONS);

  // Resolution machinery for the first-chunk gate. Holding `resolveFirstChunk`
  // in the closure lets the data callback itself short-circuit the wait
  // instead of polling on a setInterval — cleaner and zero idle timer ticks.
  let firstChunkReceived = false;
  let resolveFirstChunk: (() => void) | null = null;
  const subscription = LiveAudioStream.on("data", (b64: string) => {
    if (stopped) return;
    if (!firstChunkReceived) {
      firstChunkReceived = true;
      resolveFirstChunk?.();
    }
    const int16 = decodeBase64Pcm(b64);
    chunks.push(int16);
    totalSamples += int16.length;
    if (onLevel) {
      // Boost slightly so quiet voices still register on the bar visualiser.
      onLevel(Math.min(1, computeRmsInt16(int16) * 4));
    }
  });
  LiveAudioStream.start();

  // Verify the native AudioRecord actually started producing data. If we never
  // see a chunk within the timeout, the constructor likely failed (no mic
  // hardware on the emulator, permission revoked between request and start,
  // etc.) and we should surface a clear error rather than silently capturing
  // 12 seconds of nothing.
  await new Promise<void>((resolve, reject) => {
    if (firstChunkReceived) {
      resolve();
      return;
    }
    resolveFirstChunk = () => {
      clearTimeout(timeoutHandle);
      resolve();
    };
    const timeoutHandle = setTimeout(() => {
      if (firstChunkReceived) return;
      try {
        void LiveAudioStream.stop();
      } catch {
        /* ignore */
      }
      subscription.remove();
      recordingActive = false;
      reject(
        new Error(
          "Microphone produced no audio. On an emulator, enable virtual mic via Extended Controls → Microphone → 'Virtual microphone uses host audio input'.",
        ),
      );
    }, FIRST_CHUNK_TIMEOUT_MS);
  });

  const teardown = () => {
    if (stopped) return;
    stopped = true;
    try {
      // Fire-and-forget: stop() drives async native teardown. We don't need
      // to block the JS side on its completion — the next session's init()
      // will release any straggling recorder via the patched releaseRecorder().
      void LiveAudioStream.stop();
    } catch {
      // Native side may already be stopped — safe to ignore.
    }
    subscription.remove();
    recordingActive = false;
  };

  return {
    stop: async () => {
      teardown();
      const durationMs = Date.now() - startedAt;
      // Single allocation + flatten + Int16→Float32 normalise.
      const pcm = new Float32Array(totalSamples);
      let offset = 0;
      for (const chunk of chunks) {
        for (let i = 0; i < chunk.length; i++) {
          pcm[offset + i] = chunk[i]! / 32768;
        }
        offset += chunk.length;
      }
      // Drop refs so the chunk array is GC-eligible immediately.
      chunks.length = 0;
      return { pcm, sampleRate: TARGET_AUDIO_SAMPLE_RATE, durationMs, startedAt };
    },
    cancel: async () => {
      teardown();
      chunks.length = 0;
    },
  };
};
