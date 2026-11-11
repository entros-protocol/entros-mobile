import { act } from "react";
import { createRoot } from "test-renderer";
import VerifyRounds from "../../../app/verify/rounds";
import { pairedFailureScreen } from "../pairedFailure";
import type { PairedSessionDeps, PairedSessionListener } from "../pairedSession";
import { openJson, WALLET } from "./pairedFixtures";
import { pairedAuthorizationBody, parseOpenResponse, type PairedAuthorization } from "@/paired";
import { openPairedSession } from "@/services/pairedExecutor";
import {
  dropPairedAuthorization,
  holdPairedAuthorization,
  usablePairedAuthorization,
} from "@/state/pairedAuthorizationBuffer";

let mockWallet: string | null = WALLET;
let mockListener: PairedSessionListener;
let mockDeps: PairedSessionDeps;
const mockStopTouch = jest.fn();
const mockAbort = jest.fn(async () => undefined);
const mockStart = jest.fn(async () => undefined);
const mockCancelMotion = jest.fn(async () => undefined);
const mockCancelTouch = jest.fn();
const mockHandoff = jest.fn();
const mockReplace = jest.fn();
const mockMotionStart = jest.fn();
const mockSetFailureScreen = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock("react-native", () => ({
  StyleSheet: { create: (value: unknown) => value },
  View: ({ children }: { children: unknown }) => children,
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
jest.mock("@/theme/ThemeProvider", () => ({ useTheme: () => ({ palette: {} }) }));
jest.mock("@/state/AppState", () => ({
  useAppState: () => ({
    connection: { address: mockWallet },
    fail: jest.fn(),
    setForceOutcome: jest.fn(),
    setFailureScreen: mockSetFailureScreen,
  }),
}));
jest.mock("@/flows/pairedSession", () => ({
  createPairedSession: (deps: PairedSessionDeps, listener: PairedSessionListener) => {
    mockDeps = deps;
    mockListener = listener;
    return { start: mockStart, abort: mockAbort, trace: jest.fn(), continueRound: jest.fn() };
  },
}));
jest.mock("@/sensor/audio", () => ({
  audioPermissionGranted: async () => true,
  requestAudioPermission: jest.fn(),
}));
jest.mock("@/sensor/continuousAudio", () => ({ startContinuousRecording: jest.fn() }));
jest.mock("@/sensor/motion", () => ({ startMotionRecording: () => mockMotionStart() }));
jest.mock("@/sensor/touch", () => ({
  startTouchRecording: () => ({
    cancel: mockCancelTouch,
    stop: () => mockStopTouch(),
    push: jest.fn(),
  }),
}));
jest.mock("@/services/pairedExecutor", () => ({
  openPairedSession: jest.fn(),
  commitPairedRound: jest.fn(),
  requestPairedCue: jest.fn(),
}));
jest.mock("@/flows/singleCaptureChallenge", () => ({ holdSingleCaptureChallenge: jest.fn() }));
jest.mock("@/state/pairedSessionBuffer", () => ({
  setPairedSession: (value: unknown) => mockHandoff(value),
}));
jest.mock("@/components/pulse/SensorBars", () => ({ SensorBars: () => null }));
jest.mock("@/components/pulse/WaypointCanvas", () => ({ WaypointCanvas: () => null }));
jest.mock("@/components/primitives/Screen", () => ({
  Screen: ({ children }: { children: unknown }) => children,
}));
jest.mock("@/components/primitives/Button", () => ({ Button: () => null }));
jest.mock("@/components/primitives/PrivacyPill", () => ({ PrivacyPill: () => null }));
jest.mock("@/components/primitives/SectionLabel", () => ({ SectionLabel: () => null }));
jest.mock("@/components/primitives/Spinner", () => ({ Spinner: () => null }));
jest.mock("@/components/primitives/Text", () => ({ Text: () => null }));

beforeEach(() => {
  jest.clearAllMocks();
  mockWallet = WALLET;
  mockMotionStart.mockResolvedValue({ cancel: mockCancelMotion, stop: jest.fn() });
  dropPairedAuthorization();
});

/** An authorization the wallet signed on the intro screen, with its whole lifetime left. */
function signedAuthorization(): PairedAuthorization {
  return {
    wallet: WALLET,
    challenge: "22".repeat(32),
    expiresAt: 1_800_000_000,
    origin: "4b".repeat(16),
    mac: "92".repeat(32),
    signatureHex: "cb".repeat(64),
    lifetimeMs: 900_000,
    requestedAt: { monotonicMs: performance.now(), wallMs: Date.now() },
  };
}

test("opens with the authorization the wallet signed and hands it to the processing screen", async () => {
  const authorization = signedAuthorization();
  holdPairedAuthorization(authorization);
  const motionCapture = { samples: [], sampleRate: 0, durationMs: 0, startedAt: 0 };
  const touchCapture = { samples: [], durationMs: 0 };
  mockMotionStart.mockResolvedValue({ cancel: mockCancelMotion, stop: async () => motionCapture });
  mockStopTouch.mockReturnValue(touchCapture);
  const tree = createRoot();
  await act(async () => {
    tree.render(<VerifyRounds />);
  });

  const signal = new AbortController().signal;
  await mockDeps.open(WALLET, signal);
  expect(openPairedSession).toHaveBeenCalledWith(WALLET, {
    signal,
    authorization: pairedAuthorizationBody(authorization),
  });

  const rounds = {
    walletId: WALLET,
    open: parseOpenResponse(openJson()),
    commits: [],
    audioStartedAtMs: 0,
    audioEndedAtMs: 1,
    sessionEndsAtMs: 10000,
    nativeSampleRate: 16000,
  };
  await act(async () => {
    mockListener.complete(rounds);
  });
  // Finalize sends the one the session opened with, whatever is held by then.
  expect(mockHandoff).toHaveBeenCalledWith({
    rounds,
    motion: motionCapture,
    touch: touchCapture,
    authorization,
  });
  expect(mockReplace).toHaveBeenCalledWith("/verify/processing");
  await act(async () => {
    tree.unmount();
  });
});

test("opens with no authorization when the app holds none", async () => {
  const tree = createRoot();
  await act(async () => {
    tree.render(<VerifyRounds />);
  });
  const signal = new AbortController().signal;
  await mockDeps.open(WALLET, signal);
  expect(openPairedSession).toHaveBeenCalledWith(WALLET, { signal });
  await act(async () => {
    tree.unmount();
  });
});

test.each(["authorization_required", "authorization_invalid"])(
  "drops the authorization after the relayer answers %s, so the next attempt signs again",
  async (reason) => {
    holdPairedAuthorization(signedAuthorization());
    const tree = createRoot();
    await act(async () => {
      tree.render(<VerifyRounds />);
    });
    await act(async () => {
      mockListener.failure({ reason, status: 401 });
    });
    expect(usablePairedAuthorization(WALLET)).toBeNull();
    expect(mockSetFailureScreen).toHaveBeenCalledWith({ bucket: "soft", reason });
    await act(async () => {
      tree.unmount();
    });
  },
);

test("keeps the authorization after a failure that is not about it", async () => {
  const authorization = signedAuthorization();
  holdPairedAuthorization(authorization);
  const tree = createRoot();
  await act(async () => {
    tree.render(<VerifyRounds />);
  });
  await act(async () => {
    mockListener.failure({ reason: "round_expired" });
  });
  expect(usablePairedAuthorization(WALLET)).toBe(authorization);
  await act(async () => {
    tree.unmount();
  });
});

test.each(["SysvarRent111111111111111111111111111111111", null])(
  "cancels old-wallet capture when wallet becomes %s",
  async (next) => {
    const tree = createRoot();
    await act(async () => {
      tree.render(<VerifyRounds />);
    });
    expect(mockStart).toHaveBeenCalledWith(WALLET);
    mockWallet = next;
    await act(async () => {
      tree.render(<VerifyRounds />);
    });
    expect(mockAbort).toHaveBeenCalledTimes(1);
    expect(mockCancelMotion).toHaveBeenCalledTimes(1);
    expect(mockCancelTouch).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledTimes(1);
    await act(async () => {
      mockListener.complete({
        walletId: WALLET,
        open: parseOpenResponse(openJson()),
        commits: [],
        audioStartedAtMs: 0,
        audioEndedAtMs: 1,
        sessionEndsAtMs: 10000,
        nativeSampleRate: 16000,
      });
    });
    expect(mockHandoff).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalledWith("/verify/processing");
    await act(async () => {
      tree.unmount();
    });
  },
);

test("cancels a motion recorder that arrives after a wallet change", async () => {
  let resolve!: (value: unknown) => void;
  mockMotionStart.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const tree = createRoot();
  await act(async () => {
    tree.render(<VerifyRounds />);
  });
  mockWallet = null;
  await act(async () => {
    tree.render(<VerifyRounds />);
  });
  await act(async () => {
    resolve({ cancel: mockCancelMotion, stop: jest.fn() });
  });
  expect(mockCancelMotion).toHaveBeenCalledTimes(1);
  expect(mockStart).not.toHaveBeenCalled();
  await act(async () => {
    tree.unmount();
  });
});

test("a session failure sets the failure screen in app state before routing there", async () => {
  const tree = createRoot();
  await act(async () => {
    tree.render(<VerifyRounds />);
  });
  await act(async () => {
    mockListener.failure({ reason: "session_expired" });
  });
  expect(mockSetFailureScreen).toHaveBeenCalledTimes(1);
  expect(mockSetFailureScreen).toHaveBeenCalledWith(
    pairedFailureScreen({ reason: "session_expired" }).screen,
  );
  expect(mockReplace).toHaveBeenCalledWith("/verify/failure");
  await act(async () => {
    tree.unmount();
  });
});
