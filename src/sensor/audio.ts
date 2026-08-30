// Audio capture via react-native-live-audio-stream. The Android path requests
// raw 16-bit mono PCM at 16 kHz and reads the configured rate back before
// recording. Cross-runtime fixtures, not the request alone, establish parity.
//
// PRIVACY:
// - PCM chunks stay in this module's closure. `stop()` hands one Float32Array
//   to the caller and clears the chunk references.
// - Nothing touches disk: there's no recording file. The library streams
//   chunks directly into JS memory.
// - The level callback receives RMS computed from the chunk; the chunk
//   itself is never logged.
// - The caller sends one transient PCM encoding for phrase matching, then
//   discards both forms after the validation request.

import type { EmitterSubscription } from "react-native";
import { PermissionsAndroid, Platform } from "react-native";

import { devWarn } from "@/lib/log";

import { AudioCapture, TARGET_AUDIO_SAMPLE_RATE } from "./types";
import { normalizeCaptureRMS } from "./audioNormalization";
import { CANONICAL_SAMPLE_RATE, toCanonicalCapture } from "./resample";

export { normalizeCaptureRMS } from "./audioNormalization";

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

interface AndroidAudioRecordConfig {
  initializationState: number;
  initialized: boolean;
  configuredSampleRate: number;
}

interface AndroidAudioRecordError {
  code: number;
  message: string;
}

interface IAudioRecord {
  init(options: AudioRecordOptions): void | Promise<AndroidAudioRecordConfig>;
  start(): void | Promise<unknown>;
  // Android resolves after the patched native module stops and releases its
  // AudioRecord. The upstream iOS method returns void.
  stop(): void | Promise<unknown>;
  on(event: "data", callback: (data: string) => void): EmitterSubscription;
  on(event: "error", callback: (error: AndroidAudioRecordError) => void): EmitterSubscription;
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
const MAX_CAPTURE_MS = 12_000;

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
        "Entros extracts voice features on this device and sends transient audio to the validation service for phrase matching.",
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
  let stopped = false;
  let configuredSampleRate = TARGET_AUDIO_SAMPLE_RATE;
  let dataSubscription: EmitterSubscription | null = null;
  let errorSubscription: EmitterSubscription | null = null;
  let recordingError: Error | null = null;
  let teardownPromise: Promise<void> | null = null;
  let terminalPromise: Promise<AudioCapture | null> | null = null;

  // The data callback resolves this gate without polling.
  let firstChunkReceived = false;
  let resolveFirstChunk: (() => void) | null = null;
  let rejectFirstChunk: ((error: Error) => void) | null = null;

  const teardown = (): Promise<void> => {
    if (teardownPromise) return teardownPromise;
    stopped = true;
    teardownPromise = (async () => {
      try {
        await LiveAudioStream.stop();
      } finally {
        dataSubscription?.remove();
        errorSubscription?.remove();
        recordingActive = false;
      }
    })();
    return teardownPromise;
  };

  try {
    const nativeConfig = await LiveAudioStream.init(STREAM_OPTIONS);
    if (Platform.OS === "android") {
      if (!nativeConfig) {
        throw new Error("Microphone initialization returned no AudioRecord state.");
      }
      if (!nativeConfig.initialized) {
        throw new Error(
          `Microphone failed to initialize (AudioRecord state ${nativeConfig.initializationState}).`,
        );
      }
      if (
        !Number.isInteger(nativeConfig.configuredSampleRate) ||
        nativeConfig.configuredSampleRate < CANONICAL_SAMPLE_RATE
      ) {
        throw new Error("Microphone returned an unsupported configured sample rate.");
      }
      devWarn(
        `[Entros] AudioRecord initialized state=${nativeConfig.initializationState} sampleRateHz=${nativeConfig.configuredSampleRate}`,
      );
      configuredSampleRate = nativeConfig.configuredSampleRate;
    }

    dataSubscription = LiveAudioStream.on("data", (b64: string) => {
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
    errorSubscription = LiveAudioStream.on("error", (nativeError) => {
      if (stopped || recordingError) return;
      recordingError = new Error(`${nativeError.message} (${nativeError.code})`);
      rejectFirstChunk?.(recordingError);
      void teardown().catch(() => undefined);
    });
    await LiveAudioStream.start();
  } catch (error) {
    try {
      await teardown();
    } catch {
      // Preserve the initialization or start error.
    }
    throw error;
  }

  // Verify the native AudioRecord actually started producing data. If we never
  // see a chunk within the timeout, the constructor likely failed (no mic
  // hardware on the emulator, permission revoked between request and start,
  // etc.) and we should surface a clear error rather than silently capturing
  // 12 seconds of nothing.
  await new Promise<void>((resolve, reject) => {
    if (recordingError) {
      reject(recordingError);
      return;
    }
    if (firstChunkReceived) {
      resolve();
      return;
    }
    resolveFirstChunk = () => {
      clearTimeout(timeoutHandle);
      resolveFirstChunk = null;
      rejectFirstChunk = null;
      resolve();
    };
    rejectFirstChunk = (error) => {
      clearTimeout(timeoutHandle);
      resolveFirstChunk = null;
      rejectFirstChunk = null;
      reject(error);
    };
    const timeoutHandle = setTimeout(() => {
      if (firstChunkReceived) return;
      const error = new Error(
        "Microphone produced no audio. On an emulator, enable virtual mic via Extended Controls → Microphone → 'Virtual microphone uses host audio input'.",
      );
      rejectFirstChunk?.(error);
      void teardown().catch(() => undefined);
    }, FIRST_CHUNK_TIMEOUT_MS);
  });

  const finish = (returnCapture: boolean): Promise<AudioCapture | null> => {
    if (terminalPromise) return terminalPromise;
    const captureEndedAt = Date.now();

    terminalPromise = (async () => {
      let teardownError: unknown;
      try {
        await teardown();
      } catch (error) {
        teardownError = error;
      }

      try {
        if (recordingError) throw recordingError;
        if (teardownError) throw teardownError;
        if (!returnCapture) return null;

        // Use one allocation to flatten chunks and convert Int16 PCM to Float32.
        const nativePcm = new Float32Array(totalSamples);
        let offset = 0;
        for (const chunk of chunks) {
          for (let i = 0; i < chunk.length; i++) {
            nativePcm[offset + i] = chunk[i]! / 32768;
          }
          offset += chunk.length;
        }

        const canonical = await toCanonicalCapture(nativePcm, configuredSampleRate);
        const maxSamples = Math.round((MAX_CAPTURE_MS / 1_000) * canonical.sampleRate);
        const bounded =
          canonical.samples.length > maxSamples
            ? canonical.samples.slice(canonical.samples.length - maxSamples)
            : canonical.samples;
        const pcm = normalizeCaptureRMS(bounded);
        const durationMs = (pcm.length / canonical.sampleRate) * 1_000;

        return {
          pcm,
          sampleRate: canonical.sampleRate,
          nativeSampleRate: configuredSampleRate,
          durationMs,
          startedAt: captureEndedAt - durationMs,
        };
      } finally {
        // Drop refs so the chunk array is GC-eligible immediately.
        chunks.length = 0;
      }
    })();

    return terminalPromise;
  };

  return {
    stop: async () => {
      const capture = await finish(true);
      if (!capture) throw new Error("Audio recording was cancelled.");
      return capture;
    },
    cancel: async () => {
      await finish(false);
    },
  };
};
