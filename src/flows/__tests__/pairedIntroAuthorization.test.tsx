import { act, type ReactNode } from "react";
import { createRoot } from "test-renderer";

import Intro from "../../../app/verify/intro";
import { ensurePairedAuthorization, type PairedAuthorizationOutcome } from "../pairedAuthorization";

const WALLET = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";

let mockConnection: { address: string | null; wallet: string | null; authToken: string | null };
const mockReplace = jest.fn();
const mockAlert = jest.fn();
const mockHoldChallenge = jest.fn();
const mockUpdateAuthToken = jest.fn();

jest.mock("expo-router", () => ({ useRouter: () => ({ replace: mockReplace }) }));
jest.mock("react-native", () => ({
  Alert: { alert: (...args: unknown[]) => mockAlert(...args) },
  StyleSheet: { create: (value: unknown) => value },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
jest.mock("react-native-reanimated", () => ({
  __esModule: true,
  default: { View: ({ children }: { children: ReactNode }) => <div>{children}</div> },
  cancelAnimation: jest.fn(),
  Easing: { out: () => undefined, in: () => undefined, quad: undefined },
  useAnimatedStyle: () => ({}),
  useSharedValue: () => ({ value: 0 }),
  withDelay: () => 0,
  withRepeat: () => 0,
  withSequence: () => 0,
  withTiming: () => 0,
}));
jest.mock("@/components/icons", () => ({
  MicIcon: () => null,
  MotionIcon: () => null,
  TouchIcon: () => null,
}));
jest.mock("@/components/primitives/Button", () => ({
  Button: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button onClick={onPress}>{label}</button>
  ),
}));
jest.mock("@/components/primitives/GlowCard", () => ({
  GlowCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
jest.mock("@/components/primitives/Screen", () => ({
  Screen: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
jest.mock("@/components/primitives/SectionLabel", () => ({ SectionLabel: () => null }));
jest.mock("@/components/primitives/Text", () => ({ Text: () => null }));
jest.mock("@/theme/ThemeProvider", () => ({ useTheme: () => ({ palette: {} }) }));
jest.mock("@/config", () => ({
  config: { pairedVerify: true },
  getConnection: () => ({}),
}));
jest.mock("@/lib/log", () => ({ devWarn: jest.fn() }));
jest.mock("@/protocol/protocolConfig", () => ({
  fetchProjectionPolicy: async () => ({ current: 1 }),
  fetchProtocolConfig: async () => null,
  formatLamportsAsSol: () => "",
}));
jest.mock("@/paired", () => ({ isSupportedPairedProjectionVersion: () => true }));
jest.mock("@/sensor/audio", () => ({
  audioPermissionGranted: async () => true,
  requestAudioPermission: jest.fn(),
}));
jest.mock("@/flows/singleCaptureChallenge", () => ({
  holdSingleCaptureChallenge: (...args: unknown[]) => mockHoldChallenge(...args),
}));
jest.mock("@/flows/pairedAuthorization", () => ({ ensurePairedAuthorization: jest.fn() }));
jest.mock("@/state/AppState", () => ({
  useAppState: () => ({ connection: mockConnection, updateAuthToken: mockUpdateAuthToken }),
}));

const ensureMock = jest.mocked(ensurePairedAuthorization);

async function begin(outcome: PairedAuthorizationOutcome) {
  ensureMock.mockResolvedValue(outcome);
  const tree = createRoot();
  await act(async () => tree.render(<Intro />));
  const button = tree.container.queryAll((node) => node.type === "button")[0]!;
  await act(async () => button.props.onClick());
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConnection = { address: WALLET, wallet: "phantom", authToken: "token-1" };
});

describe("paired intro", () => {
  test("has the wallet authorize before the rounds screen starts a recorder", async () => {
    const tree = await begin({ kind: "ready", authorization: null });
    const [session] = ensureMock.mock.calls[0]!;
    expect(session).toMatchObject({ address: WALLET, kind: "phantom", authToken: "token-1" });
    expect(mockReplace).toHaveBeenCalledWith("/verify/rounds");
    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockHoldChallenge).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
    await act(async () => tree.unmount());
  });

  test.each<[string, PairedAuthorizationOutcome, string, string]>([
    [
      "the person declines",
      { kind: "declined" },
      "Wallet authorization needed",
      "Approve the message in your wallet to start verification.",
    ],
    [
      "the wallet cannot sign",
      { kind: "wallet-failed", message: "Wallet returned an empty accounts list." },
      "Wallet couldn't sign",
      "Reconnect your wallet, then try again.",
    ],
    [
      "the wallet never answers",
      { kind: "wallet-unresponsive" },
      "Wallet did not respond",
      "Open your wallet and try again.",
    ],
    [
      "the signature arrives too late",
      { kind: "expired" },
      "Authorization expired",
      "The wallet prompt stayed open too long. Try again.",
    ],
  ])("stays on the intro when %s", async (_name, outcome, title, body) => {
    const tree = await begin(outcome);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledWith(title, body);
    await act(async () => tree.unmount());
  });

  test.each([
    [429, "Too many requests. Wait a moment, then try again."],
    [503, "The verification service is unavailable. Check your network and try again."],
  ])("stays on the intro when the request fails with %s", async (status, body) => {
    const tree = await begin({ kind: "failed", failure: { status } });
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledWith("Couldn't start verification", body);
    await act(async () => tree.unmount());
  });

  test("returns to the connect screen when the wallet session is gone", async () => {
    mockConnection = { address: WALLET, wallet: "phantom", authToken: null };
    const tree = await begin({ kind: "ready", authorization: null });
    expect(ensureMock).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith("/connect");
    await act(async () => tree.unmount());
  });
});
