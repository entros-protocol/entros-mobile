import { act } from "react";
import { createRoot } from "test-renderer";

import { wipeBaseline } from "@/identity/baseline";
import { fetchIdentityState, toAppStateIdentity } from "@/protocol/identity";
import type { OnChainIdentity } from "@/protocol/identity";

import { AppStateProvider, useAppState } from "../AppState";

const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
const mockGetSecure = jest.fn();
const mockSetSecure = jest.fn();
const mockDeleteSecure = jest.fn();

const mockPrograms: { entrosAnchor?: unknown } = {};

jest.mock("@/config", () => ({
  config: {
    cluster: "devnet",
    get programs() {
      return mockPrograms;
    },
  },
  getConnection: jest.fn(),
}));
jest.mock("@/identity/baseline", () => ({ wipeBaseline: jest.fn() }));
jest.mock("@/lib/log", () => ({ devWarn: jest.fn() }));
jest.mock("@/protocol/identity", () => ({
  fetchIdentityState: jest.fn(),
  toAppStateIdentity: jest.fn(),
}));
jest.mock("@/wallet/mwa", () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
  disconnect: (...args: unknown[]) => mockDisconnect(...args),
}));
jest.mock("@/storage/secure", () => ({
  SecureKeys: {
    WALLET_ADDRESS: "wallet_address",
    WALLET_AUTH_TOKEN: "wallet_auth_token",
    WALLET_LABEL: "wallet_label",
    WALLET_KIND: "wallet_kind",
  },
  getSecure: (...args: unknown[]) => mockGetSecure(...args),
  setSecure: (...args: unknown[]) => mockSetSecure(...args),
  deleteSecure: (...args: unknown[]) => mockDeleteSecure(...args),
}));

type Context = ReturnType<typeof useAppState>;

describe("wallet-scoped auth token persistence", () => {
  beforeEach(() => {
    mockConnect.mockReset();
    mockDisconnect.mockReset().mockResolvedValue(undefined);
    mockGetSecure.mockReset().mockResolvedValue(null);
    mockSetSecure.mockReset().mockResolvedValue(undefined);
    mockDeleteSecure.mockReset().mockResolvedValue(undefined);
  });

  test("drops a late token rotation after the connection revision changes", async () => {
    const walletA = "11111111111111111111111111111111";
    const walletB = "SysvarRent111111111111111111111111111111111";
    const stored = new Map<string, string>();
    let releaseRotation: (() => void) | undefined;
    const rotationWrite = new Promise<void>((resolve) => {
      releaseRotation = resolve;
    });
    mockSetSecure.mockImplementation(async (key: string, value: string) => {
      if (key === "wallet_auth_token" && value === "late-token-a") {
        await rotationWrite;
      }
      stored.set(key, value);
    });
    mockDeleteSecure.mockImplementation(async (key: string) => {
      stored.delete(key);
    });
    mockConnect
      .mockResolvedValueOnce({
        address: walletA,
        authToken: "token-a",
        label: "A",
        wallet: "phantom",
      })
      .mockResolvedValueOnce({
        address: walletB,
        authToken: "token-b",
        label: "B",
        wallet: "solflare",
      });

    let context: Context | null = null;
    const Consumer = () => {
      context = useAppState();
      return null;
    };
    const tree = createRoot();
    await act(async () => {
      tree.render(
        <AppStateProvider>
          <Consumer />
        </AppStateProvider>,
      );
    });
    await act(async () => {
      await context!.connect("phantom");
    });

    let accepted: boolean | undefined;
    const lateRotation = context!
      .updateAuthToken("late-token-a", walletA, "phantom")
      .then((value) => {
        accepted = value;
      });
    const disconnect = context!.disconnect();
    releaseRotation?.();
    await act(async () => {
      await Promise.all([lateRotation, disconnect]);
      await context!.connect("solflare");
    });

    expect(accepted).toBe(false);
    expect(context!.connection).toMatchObject({
      connected: true,
      address: walletB,
      wallet: "solflare",
      authToken: "token-b",
    });
    expect(stored.get("wallet_address")).toBe(walletB);
    expect(stored.get("wallet_auth_token")).toBe("token-b");
    await act(async () => tree.unmount());
  });

  test("bounds quality retries, keeps reset intent and records no failed history", async () => {
    let context: Context | null = null;
    const Consumer = () => {
      context = useAppState();
      return null;
    };
    const tree = createRoot();
    await act(async () => {
      tree.render(
        <AppStateProvider>
          <Consumer />
        </AppStateProvider>,
      );
    });
    await act(async () => context!.setFlowIntent("reset"));
    expect(context!.recordAnchorRetry()).toBe(2);
    expect(context!.recordAnchorRetry()).toBe(1);
    expect(context!.recordAnchorRetry()).toBe(0);
    expect(context!.recordAnchorRetry()).toBe(0);
    expect(context!.flow.intent).toBe("reset");
    expect(context!.history).toEqual([]);
    context!.clearAnchorRetries();
    expect(context!.recordAnchorRetry()).toBe(2);
    await act(async () => tree.unmount());
  });

  test("clears quality retries on wallet changes, success and an explicit intent change", async () => {
    let context: Context | null = null;
    const Consumer = () => {
      context = useAppState();
      return null;
    };
    mockConnect.mockResolvedValue({ address: "wallet-a", authToken: "token", wallet: "phantom" });
    const tree = createRoot();
    await act(async () =>
      tree.render(
        <AppStateProvider>
          <Consumer />
        </AppStateProvider>,
      ),
    );
    await act(async () => context!.connect("phantom"));
    expect(context!.recordAnchorRetry()).toBe(2);
    expect(context!.recordAnchorRetry()).toBe(1);
    mockConnect.mockResolvedValue({ address: "wallet-b", authToken: "token", wallet: "phantom" });
    await act(async () => context!.connect("phantom"));
    mockConnect.mockResolvedValue({ address: "wallet-a", authToken: "token", wallet: "phantom" });
    await act(async () => context!.connect("phantom"));
    expect(context!.recordAnchorRetry()).toBe(2);
    await act(async () => context!.verify(2, "verified"));
    expect(context!.recordAnchorRetry()).toBe(2);
    await act(async () => context!.setFlowIntent("reset"));
    expect(context!.recordAnchorRetry()).toBe(2);
    await act(async () => context!.resetComplete("reset"));
    expect(context!.recordAnchorRetry()).toBe(2);
    await act(async () => tree.unmount());
  });

  test("a settings reset wipes the connected wallet's baseline on this cluster", async () => {
    const wallet = "SysvarRent111111111111111111111111111111111";
    jest.mocked(wipeBaseline).mockReset().mockResolvedValue(undefined);
    mockConnect.mockResolvedValue({ address: wallet, authToken: "token", wallet: "phantom" });
    let context: Context | null = null;
    const Consumer = () => {
      context = useAppState();
      return null;
    };
    const tree = createRoot();
    await act(async () =>
      tree.render(
        <AppStateProvider>
          <Consumer />
        </AppStateProvider>,
      ),
    );
    // Before a wallet connects, the wipe covers the entry earlier builds kept for every wallet.
    await act(async () => context!.resetBaseline());
    expect(wipeBaseline).toHaveBeenLastCalledWith(null);
    await act(async () => context!.connect("phantom"));
    await act(async () => context!.resetBaseline());
    // With no chain commitment known, the unscoped entry cannot be matched to this wallet.
    expect(wipeBaseline).toHaveBeenLastCalledWith({ cluster: "devnet", wallet }, null);
    await act(async () => tree.unmount());
  });

  test("a settings reset names the wallet's chain commitment for the unscoped entry", async () => {
    const wallet = "SysvarRent111111111111111111111111111111111";
    jest.mocked(wipeBaseline).mockReset().mockResolvedValue(undefined);
    mockConnect.mockResolvedValue({ address: wallet, authToken: "token", wallet: "phantom" });
    mockPrograms.entrosAnchor = "anchor-program";
    jest.mocked(fetchIdentityState).mockResolvedValue({} as OnChainIdentity);
    jest.mocked(toAppStateIdentity).mockReturnValue({
      hasAnchor: true,
      trustScore: 1,
      verifications: 1,
      lastVerifiedAt: null,
      commitment: `0x${"ab".repeat(32)}`,
      mint: null,
      createdAt: null,
      recentTimestamps: [],
      lastResetAt: null,
    });
    let context: Context | null = null;
    const Consumer = () => {
      context = useAppState();
      return null;
    };
    const tree = createRoot();
    try {
      await act(async () =>
        tree.render(
          <AppStateProvider>
            <Consumer />
          </AppStateProvider>,
        ),
      );
      await act(async () => context!.connect("phantom"));
      await act(async () => {
        await context!.hydrateIdentity({ force: true });
      });
      expect(context!.identity.commitment).toBe(`0x${"ab".repeat(32)}`);
      await act(async () => context!.resetBaseline());
      expect(wipeBaseline).toHaveBeenLastCalledWith(
        { cluster: "devnet", wallet },
        new Uint8Array(32).fill(0xab),
      );
    } finally {
      delete mockPrograms.entrosAnchor;
      await act(async () => tree.unmount());
    }
  });

  test("holds what the failure screen shows until the next failure replaces it", async () => {
    let context: Context | null = null;
    const Consumer = () => {
      context = useAppState();
      return null;
    };
    const tree = createRoot();
    await act(async () =>
      tree.render(
        <AppStateProvider>
          <Consumer />
        </AppStateProvider>,
      ),
    );
    expect(context!.failureScreen).toBeNull();
    await act(async () => context!.setFailureScreen({ bucket: "rate-limited", retryAfterSec: 30 }));
    expect(context!.failureScreen).toEqual({ bucket: "rate-limited", retryAfterSec: 30 });
    await act(async () => context!.setFailureScreen({ bucket: "generic" }));
    expect(context!.failureScreen).toEqual({ bucket: "generic" });
    await act(async () => tree.unmount());
  });
});
