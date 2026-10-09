import { act } from "react";
import { createRoot } from "test-renderer";
import Processing from "../../../app/verify/processing";
import type { PairedVerificationContext } from "../pairedVerification";
import { WALLET } from "./pairedFixtures";

const mockOriginalWallet = WALLET;
let mockAddress: string | null = WALLET;
let mockIntent: "verify" | "reset" = "verify";
let mockPaired = true;
let mockContext: PairedVerificationContext;
let mockResolve: (value: unknown) => void;
const mockReplace = jest.fn();
const mockVerify = jest.fn();
const mockRelease = jest.fn();
const mockRun = jest.fn();
const mockPrepareSingle = jest.fn();
const mockFail = jest.fn();
const mockSetFlowIntent = jest.fn();
const mockRecordAnchorRetry = jest.fn();
const mockResetComplete = jest.fn();
const mockSegment = new Uint8Array([1, 2, 3]);
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock("react-native", () => ({
  StyleSheet: { create: (value: unknown) => value },
  View: ({ children }: { children: unknown }) => children,
}));
jest.mock("@/theme/ThemeProvider", () => ({ useTheme: () => ({ palette: {} }) }));
jest.mock("@/components/primitives/Screen", () => ({
  Screen: ({ children }: { children: unknown }) => children,
}));
jest.mock("@/components/pulse/ProcessingStage", () => ({ ProcessingStage: () => null }));
jest.mock("@/state/AppState", () => ({
  useAppState: () => ({
    connection: { address: mockAddress, wallet: "phantom", authToken: "token" },
    dev: {},
    flow: { intent: mockIntent },
    verify: mockVerify,
    resetComplete: mockResetComplete,
    fail: mockFail,
    setForceOutcome: jest.fn(),
    setFlowIntent: mockSetFlowIntent,
    recordAnchorRetry: mockRecordAnchorRetry,
    updateAuthToken: jest.fn(),
  }),
}));
jest.mock("@/extraction", () => ({ MIN_AUDIO_SAMPLES: 16000 }));
jest.mock("@/flows/chainContext", () => ({
  readChainContext: async () => ({ kind: "ok", chain: { projectionVersion: 1 } }),
}));
jest.mock("@/flows/pairedVerification", () => ({
  preparePairedVerification: (_handoff: unknown, context: PairedVerificationContext) => {
    mockContext = context;
    return new Promise((resolve) => {
      mockResolve = resolve;
    });
  },
}));
jest.mock("@/flows/verificationPipeline", () => ({
  WalletSession: class {},
  runVerificationPipeline: (input: unknown) => mockRun(input),
  prepareSingleCapture: (...args: unknown[]) => mockPrepareSingle(...args),
}));
jest.mock("@/state/pairedSessionBuffer", () => ({
  takePairedSession: () =>
    mockPaired
      ? {
          rounds: {
            walletId: mockOriginalWallet,
            sessionEndsAtMs: performance.now() + 10000,
            commits: [{ segment: mockSegment }],
          },
          motion: { samples: [] },
          touch: { samples: [], curveTrace: [] },
        }
      : null,
  clearPairedSession: jest.fn(),
}));
jest.mock("@/state/captureBuffer", () => ({
  takeCapture: () => ({ audio: { pcm: new Float32Array(16_000) } }),
  clearCapture: jest.fn(),
}));
jest.mock("@/state/challengeBuffer", () => ({
  peekChallenge: () => ({
    projectionVersion: 1,
    expiresAtMs: Number.POSITIVE_INFINITY,
    nonce: new Uint8Array(32),
  }),
  takeChallenge: jest.fn(),
  clearChallenge: jest.fn(),
}));
jest.mock("@/services/playIntegrity", () => ({ tokenFor: jest.fn() }));
jest.mock("@/lib/log", () => ({ devWarn: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  mockAddress = WALLET;
  mockIntent = "verify";
  mockPaired = true;
  mockRecordAnchorRetry.mockReturnValue(2);
  mockSegment.set([1, 2, 3]);
  mockRun.mockResolvedValue({ kind: "success", txSignature: "stale" });
  mockPrepareSingle.mockResolvedValue({ extracted: {}, release: mockRelease, validate: jest.fn() });
});

test.each(["SysvarRent111111111111111111111111111111111", null])(
  "cancels paired processing when wallet becomes %s",
  async (next) => {
    const tree = createRoot();
    await act(async () => {
      tree.render(<Processing />);
    });
    expect(mockContext.isCancelled()).toBe(false);
    mockAddress = next;
    await act(async () => {
      tree.render(<Processing />);
    });
    expect(mockContext.isCancelled()).toBe(true);
    expect(mockContext.signal?.aborted).toBe(true);
    await act(async () => {
      mockResolve({ kind: "ready", extracted: {}, release: mockRelease });
    });
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockSegment).toEqual(new Uint8Array(3));
    await act(async () => {
      tree.unmount();
    });
  },
);

test.each([2, 1, 0])(
  "routes a reset quality retry with %s attempts left and no failed history",
  async (remaining) => {
    mockIntent = "reset";
    mockRecordAnchorRetry.mockReturnValue(remaining);
    mockRun.mockResolvedValue({ kind: "validation-failed", failure: { reason: "anchor_retry" } });
    const tree = createRoot();
    await act(async () => tree.render(<Processing />));
    await act(async () => mockResolve({ kind: "ready", extracted: {}, release: mockRelease }));
    expect(mockContext.flowIntent).toBe("reset");
    expect(mockRecordAnchorRetry).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: "/verify/failure",
      params: { bucket: "soft", reason: "anchor_retry", attemptsRemaining: String(remaining) },
    });
    expect(mockFail).not.toHaveBeenCalled();
    expect(mockSetFlowIntent).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockResetComplete).not.toHaveBeenCalled();
    expect(mockSegment).toEqual(new Uint8Array(3));
    await act(async () => tree.unmount());
  },
);

test("unmount clears session expiry and aborts pending paired work", async () => {
  jest.useFakeTimers();
  const timeoutSpy = jest.spyOn(global, "setTimeout");
  const clearSpy = jest.spyOn(global, "clearTimeout");
  const tree = createRoot();
  try {
    await act(async () => tree.render(<Processing />));
    const expiryIndex = timeoutSpy.mock.calls.findIndex(([, delay]) => delay === 10_000);
    expect(expiryIndex).toBeGreaterThanOrEqual(0);
    const expiryTimer = timeoutSpy.mock.results[expiryIndex]!.value;
    await act(async () => tree.unmount());
    expect(clearSpy).toHaveBeenCalledWith(expiryTimer);
    expect(mockContext.signal?.aborted).toBe(true);
    await act(async () => mockResolve({ kind: "ready", extracted: {}, release: mockRelease }));
    jest.advanceTimersByTime(10_000);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockSegment).toEqual(new Uint8Array(3));
  } finally {
    clearSpy.mockRestore();
    timeoutSpy.mockRestore();
    jest.useRealTimers();
  }
});

test("legacy baseline refusal reaches the fatal paired-required surface", async () => {
  mockPaired = false;
  mockRun.mockResolvedValue({
    kind: "validation-failed",
    failure: { kind: "hard-reject", reason: "paired_required" },
  });
  const tree = createRoot();
  await act(async () => tree.render(<Processing />));
  expect(mockPrepareSingle).toHaveBeenCalledTimes(1);
  expect(mockReplace).toHaveBeenCalledWith({
    pathname: "/verify/failure",
    params: {
      bucket: "session-error",
      reason: "paired_required",
      message: "paired_required",
    },
  });
  expect(mockRecordAnchorRetry).not.toHaveBeenCalled();
  expect(mockVerify).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});
