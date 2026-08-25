import type { ReactElement } from "react";
import React from "react";

import { AppStateProvider, useAppState } from "../AppState";

const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
const mockGetSecure = jest.fn();
const mockSetSecure = jest.fn();
const mockDeleteSecure = jest.fn();

jest.mock("@/config", () => ({ config: { programs: {} }, getConnection: jest.fn() }));
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

const renderer = require("react-test-renderer") as {
  act: (operation: () => void | Promise<void>) => Promise<void>;
  create: (element: ReactElement) => { unmount: () => void };
};

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
    let tree: { unmount: () => void } | undefined;
    await renderer.act(async () => {
      tree = renderer.create(
        <AppStateProvider>
          <Consumer />
        </AppStateProvider>,
      );
    });
    await renderer.act(async () => {
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
    await renderer.act(async () => {
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
    tree?.unmount();
  });
});
