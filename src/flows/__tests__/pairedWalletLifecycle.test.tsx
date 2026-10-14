import { act } from "react";
import { createRoot } from "test-renderer";
import VerifyRounds from "../../../app/verify/rounds";
import type { PairedSessionListener } from "../pairedSession";
import { openJson, WALLET } from "./pairedFixtures";
import { parseOpenResponse } from "@/paired";

let mockWallet: string | null = WALLET;
let mockListener: PairedSessionListener;
const mockAbort = jest.fn(async () => undefined);
const mockStart = jest.fn(async () => undefined);
const mockCancelMotion = jest.fn(async () => undefined);
const mockCancelTouch = jest.fn();
const mockHandoff = jest.fn();
const mockReplace = jest.fn();
const mockMotionStart = jest.fn();
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
  }),
}));
jest.mock("@/flows/pairedSession", () => ({
  createPairedSession: (_deps: unknown, listener: PairedSessionListener) => {
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
  startTouchRecording: () => ({ cancel: mockCancelTouch, stop: jest.fn(), push: jest.fn() }),
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
