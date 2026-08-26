import { type AudioRecorder, normalizeCaptureRMS, startAudioRecording } from "../audio";
import {
  buildValidationRequestDigest,
  type ValidationDigestRequest,
} from "@/services/validationAuthorization";

const mockInit = jest.fn();
const mockStart = jest.fn();
const mockStop = jest.fn();
const mockRemove = jest.fn();
let mockDataCallback: ((data: string) => void) | null = null;
let mockErrorCallback: ((error: { code: number; message: string }) => void) | null = null;

jest.mock("react-native", () => ({
  PermissionsAndroid: {
    PERMISSIONS: { RECORD_AUDIO: "android.permission.RECORD_AUDIO" },
    RESULTS: { GRANTED: "granted" },
    check: jest.fn(),
    request: jest.fn(),
  },
  Platform: { OS: "android" },
}));

jest.mock("react-native-live-audio-stream", () => ({
  __esModule: true,
  default: {
    init: (...args: unknown[]) => mockInit(...args),
    on: (event: string, callback: (value: never) => void) => {
      if (event === "data") {
        mockDataCallback = callback as typeof mockDataCallback;
      } else if (event === "error") {
        mockErrorCallback = callback as typeof mockErrorCallback;
      }
      return { remove: mockRemove };
    },
    start: (...args: unknown[]) => mockStart(...args),
    stop: (...args: unknown[]) => mockStop(...args),
  },
}));

const initializedConfig = (configuredSampleRate: number) => ({
  initializationState: 1,
  initialized: true,
  configuredSampleRate,
});

const emitPcmChunk = () => {
  mockDataCallback?.(Buffer.from([0x00, 0x40, 0x00, 0x40, 0x00, 0x40]).toString("base64"));
};

const emitSamples = (count: number, value = 0x4000) => {
  const bytes = Buffer.allocUnsafe(count * 2);
  for (let index = 0; index < count; index++) bytes.writeInt16LE(value, index * 2);
  mockDataCallback?.(bytes.toString("base64"));
};

describe("Android AudioRecord contract", () => {
  beforeEach(() => {
    jest.useRealTimers();
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockDataCallback = null;
    mockErrorCallback = null;
    mockInit.mockReset().mockResolvedValue(initializedConfig(16_000));
    mockStart.mockReset().mockImplementation(emitPcmChunk);
    mockStop.mockReset().mockResolvedValue(null);
    mockRemove.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("rejects an uninitialized recorder before start and clears the session latch", async () => {
    mockInit.mockResolvedValueOnce({
      initializationState: 0,
      initialized: false,
      configuredSampleRate: 16_000,
    });

    await expect(startAudioRecording()).rejects.toThrow(
      "Microphone failed to initialize (AudioRecord state 0).",
    );
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockStop).toHaveBeenCalledTimes(1);

    const recorder = await startAudioRecording();
    await recorder.cancel();
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["missing readback", undefined],
    ["zero rate", initializedConfig(0)],
    ["below canonical rate", initializedConfig(8_000)],
    ["fractional rate", initializedConfig(16_000.5)],
  ])("rejects %s before start", async (_label, nativeConfig) => {
    mockInit.mockResolvedValueOnce(nativeConfig);

    await expect(startAudioRecording()).rejects.toThrow(/AudioRecord state|sample rate/);
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  test("canonicalizes PCM while preserving the configured native rate", async () => {
    mockInit.mockResolvedValueOnce(initializedConfig(48_000));

    const recorder = await startAudioRecording();
    const capture = await recorder.stop();

    expect(mockInit).toHaveBeenCalledWith({
      sampleRate: 16_000,
      channels: 1,
      bitsPerSample: 16,
      audioSource: 1,
      bufferSize: 8192,
    });
    expect(console.warn).toHaveBeenCalledWith(
      "[Entros] AudioRecord initialized state=1 sampleRateHz=48000",
    );
    expect(capture.nativeSampleRate).toBe(48_000);
    expect(capture.sampleRate).toBe(16_000);
    expect(capture.pcm).toHaveLength(1);
    expect(capture.pcm[0]).not.toBe(0);
  });

  test("cleans up when native start rejects and permits another attempt", async () => {
    mockStart.mockRejectedValueOnce(new Error("native start failed"));

    await expect(startAudioRecording()).rejects.toThrow("native start failed");
    expect(mockRemove).toHaveBeenCalledTimes(2);
    expect(mockStop).toHaveBeenCalledTimes(1);

    const recorder = await startAudioRecording();
    await recorder.cancel();
    expect(mockStart).toHaveBeenCalledTimes(2);
  });

  test("keeps the session latched until native teardown completes", async () => {
    let finishStop: (() => void) | undefined;
    mockStop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );

    const recorder = await startAudioRecording();
    const cancellation = recorder.cancel();

    await expect(startAudioRecording()).rejects.toThrow("Audio recording already in progress.");
    expect(mockStart).toHaveBeenCalledTimes(1);

    finishStop?.();
    await cancellation;

    const nextRecorder = await startAudioRecording();
    await nextRecorder.cancel();
    expect(mockStart).toHaveBeenCalledTimes(2);
  });

  test("rejects when initialized AudioRecord produces no PCM", async () => {
    jest.useFakeTimers();
    mockStart.mockImplementationOnce(() => undefined);

    const rejection = expect(startAudioRecording()).rejects.toThrow(
      "Microphone produced no audio.",
    );
    await jest.advanceTimersByTimeAsync(1_500);
    await rejection;

    expect(mockRemove).toHaveBeenCalledTimes(2);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  test("rejects a capture when the native recorder fails after producing PCM", async () => {
    const recorder = await startAudioRecording();

    mockErrorCallback?.({ code: -6, message: "AudioRecord read failed" });

    await expect(recorder.stop()).rejects.toThrow("AudioRecord read failed (-6)");
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  test("rejects a native read failure before the first PCM chunk", async () => {
    mockStart.mockImplementationOnce(() => {
      mockErrorCallback?.({ code: -3, message: "AudioRecord read failed" });
    });

    await expect(startAudioRecording()).rejects.toThrow("AudioRecord read failed (-3)");
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockRemove).toHaveBeenCalledTimes(2);

    const recorder = await startAudioRecording();
    await recorder.cancel();
  });

  test("rejects stop when cancellation owns teardown", async () => {
    let finishStop: (() => void) | undefined;
    mockStop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    const recorder = await startAudioRecording();

    const cancellation = recorder.cancel();
    const capture = recorder.stop();
    finishStop?.();

    await cancellation;
    await expect(capture).rejects.toThrow("Audio recording was cancelled.");
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  test("preserves PCM when cancellation races after stop", async () => {
    let finishStop: (() => void) | undefined;
    mockStop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    const recorder = await startAudioRecording();

    const capture = recorder.stop();
    const cancellation = recorder.cancel();
    finishStop?.();

    const completed = await capture;
    expect(completed.pcm).toHaveLength(3);
    expect(completed.pcm[0]).not.toBe(0);
    await cancellation;
    await expect(recorder.stop()).resolves.toBe(completed);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  test("reports the first-chunk timeout without waiting for native teardown", async () => {
    jest.useFakeTimers();
    let finishStop: (() => void) | undefined;
    mockStart.mockImplementationOnce(() => undefined);
    mockStop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );

    const recording = startAudioRecording();
    const rejection = expect(recording).rejects.toThrow("Microphone produced no audio.");
    await jest.advanceTimersByTimeAsync(1_500);
    await rejection;

    finishStop?.();
    await Promise.resolve();
    await Promise.resolve();
  });

  test("bounds and canonicalizes an oversized 48 kHz capture", async () => {
    mockInit.mockResolvedValueOnce(initializedConfig(48_000));
    mockStart.mockImplementationOnce(() => emitSamples(48_000 * 13));

    const recorder = await startAudioRecording();
    const capture = await recorder.stop();

    expect(capture.nativeSampleRate).toBe(48_000);
    expect(capture.sampleRate).toBe(16_000);
    expect(capture.pcm).toHaveLength(192_000);
    expect(capture.durationMs).toBe(12_000);

    const request: ValidationDigestRequest = {
      baseline_reset: false,
      features: new Array(308).fill(0),
      audio_samples_b64: "transient-pcm",
      audio_sample_rate_hz: capture.sampleRate,
    };
    const mislabeled = { ...request, audio_sample_rate_hz: capture.nativeSampleRate };

    expect(request.audio_sample_rate_hz).toBe(16_000);
    expect(buildValidationRequestDigest(request)).not.toEqual(
      buildValidationRequestDigest(mislabeled),
    );
  }, 30_000);

  test("matches Pulse capture-level RMS normalization", () => {
    const normalized = normalizeCaptureRMS(new Float32Array([0.25, -0.25, 0.25, -0.25]));
    const rms = Math.sqrt(
      normalized.reduce((sum, sample) => sum + sample * sample, 0) / normalized.length,
    );

    expect(rms).toBeCloseTo(0.05, 6);
  });

  test("keeps one native owner under concurrent start pressure", async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 64 }, () => startAudioRecording()),
    );
    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<AudioRecorder> => attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult => attempt.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(63);
    expect(rejected.every((attempt) => attempt.reason instanceof Error)).toBe(true);
    await fulfilled[0]!.value.cancel();
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledTimes(1);
  });

  test("releases listeners across 500 sequential capture cycles", async () => {
    for (let cycle = 0; cycle < 500; cycle++) {
      const recorder = await startAudioRecording();
      await recorder.cancel();
    }

    expect(mockInit).toHaveBeenCalledTimes(500);
    expect(mockStart).toHaveBeenCalledTimes(500);
    expect(mockStop).toHaveBeenCalledTimes(500);
    expect(mockRemove).toHaveBeenCalledTimes(1_000);
  });
});
