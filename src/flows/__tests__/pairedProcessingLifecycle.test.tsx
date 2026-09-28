import { act } from "react";
import { createRoot } from "test-renderer";
import Processing from "../../../app/verify/processing";
import type { PairedVerificationContext } from "../pairedVerification";
import { WALLET } from "./pairedFixtures";

const mockOriginalWallet = WALLET;
let mockAddress: string | null = WALLET;
let mockContext: PairedVerificationContext;
let mockResolve: (value: unknown) => void;
const mockReplace = jest.fn();
const mockVerify = jest.fn();
const mockRelease = jest.fn();
const mockRun = jest.fn();
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
    flow: { intent: "verify" },
    verify: mockVerify,
    resetComplete: jest.fn(),
    fail: jest.fn(),
    setForceOutcome: jest.fn(),
    setFlowIntent: jest.fn(),
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
  prepareSingleCapture: jest.fn(),
}));
jest.mock("@/state/pairedSessionBuffer", () => ({
  takePairedSession: () => ({
    rounds: {
      walletId: mockOriginalWallet,
      sessionEndsAtMs: performance.now() + 10000,
      commits: [{ segment: mockSegment }],
    },
    motion: { samples: [] },
    touch: { samples: [], curveTrace: [] },
  }),
  clearPairedSession: jest.fn(),
}));
jest.mock("@/services/playIntegrity", () => ({ tokenFor: jest.fn() }));
jest.mock("@/lib/log", () => ({ devWarn: jest.fn() }));

beforeEach(() => {
  jest.clearAllMocks();
  mockAddress = WALLET;
  mockSegment.set([1, 2, 3]);
  mockRun.mockResolvedValue({ kind: "success", txSignature: "stale" });
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
