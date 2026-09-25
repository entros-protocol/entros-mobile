import { ed25519 } from "@noble/curves/ed25519";
import { PublicKey, Transaction } from "@solana/web3.js";

import { signAndSendTransaction, signMessage } from "../mwa";

const mockTransact = jest.fn();

jest.mock("@/config", () => ({ config: { cluster: "devnet" } }));
jest.mock("react-native", () => ({
  Platform: { OS: "android" },
  Linking: { canOpenURL: jest.fn(), openURL: jest.fn() },
}));
jest.mock("@solana-mobile/mobile-wallet-adapter-protocol-web3js", () => ({
  transact: (...args: unknown[]) => mockTransact(...args),
}));

describe("MWA validation message signing", () => {
  beforeEach(() => mockTransact.mockReset());

  test("uses the reauthorized account and returns the rotated token", async () => {
    const privateKey = new Uint8Array(32).fill(5);
    const publicKey = ed25519.getPublicKey(privateKey);
    const walletAddress = new PublicKey(publicKey).toBase58();
    const accountAddress = Buffer.from(publicKey).toString("base64");
    const message = new TextEncoder().encode("projection 2 authorization");
    const signature = ed25519.sign(message, privateKey);
    const signedPayload = new Uint8Array([...message, ...signature]);
    const wallet = {
      reauthorize: jest.fn().mockResolvedValue({
        auth_token: "rotated-token",
        accounts: [{ address: accountAddress, label: "Test" }],
      }),
      signMessages: jest.fn().mockResolvedValue([signedPayload]),
    };
    mockTransact.mockImplementation(async (callback: (value: typeof wallet) => unknown) =>
      callback(wallet),
    );
    const events: string[] = [];

    await expect(
      signMessage("old-token", message, walletAddress, "phantom", 5_000, async (authToken) => {
        expect(authToken).toBe("rotated-token");
        events.push("persisted");
      }),
    ).resolves.toEqual({ signature, authToken: "rotated-token" });
    events.push("returned");
    expect(events).toEqual(["persisted", "returned"]);
    expect(wallet.signMessages).toHaveBeenCalledWith({
      addresses: [accountAddress],
      payloads: [message],
    });
  });

  test("rejects a reauthorized account that differs from the connected wallet", async () => {
    const accountAddress = Buffer.from(new Uint8Array(32).fill(4)).toString("base64");
    const wallet = {
      reauthorize: jest.fn().mockResolvedValue({
        auth_token: "rotated-token",
        accounts: [{ address: accountAddress }],
      }),
      signMessages: jest.fn(),
    };
    mockTransact.mockImplementation(async (callback: (value: typeof wallet) => unknown) =>
      callback(wallet),
    );

    await expect(
      signMessage(
        "old-token",
        new TextEncoder().encode("message"),
        new PublicKey(new Uint8Array(32).fill(3)).toBase58(),
        "phantom",
        5_000,
      ),
    ).rejects.toThrow("does not match the connected wallet");
    expect(wallet.signMessages).not.toHaveBeenCalled();
  });

  test("exposes a rotated token before message signing can fail", async () => {
    const privateKey = new Uint8Array(32).fill(6);
    const publicKey = ed25519.getPublicKey(privateKey);
    const walletAddress = new PublicKey(publicKey).toBase58();
    const accountAddress = Buffer.from(publicKey).toString("base64");
    const onAuthTokenRotated = jest.fn().mockResolvedValue(undefined);
    const wallet = {
      reauthorize: jest.fn().mockResolvedValue({
        auth_token: "rotated-token",
        accounts: [{ address: accountAddress }],
      }),
      signMessages: jest.fn().mockRejectedValue(new Error("User rejected signing")),
    };
    mockTransact.mockImplementation(async (callback: (value: typeof wallet) => unknown) =>
      callback(wallet),
    );

    await expect(
      signMessage(
        "old-token",
        new TextEncoder().encode("message"),
        walletAddress,
        "phantom",
        5_000,
        onAuthTokenRotated,
      ),
    ).rejects.toThrow("User rejected signing");
    expect(onAuthTokenRotated).toHaveBeenCalledWith("rotated-token");
  });

  test("exposes and scopes a rotated token before transaction signing", async () => {
    const publicKey = new Uint8Array(32).fill(8);
    const walletAddress = new PublicKey(publicKey).toBase58();
    const accountAddress = Buffer.from(publicKey).toString("base64");
    const events: string[] = [];
    const wallet = {
      reauthorize: jest.fn().mockResolvedValue({
        auth_token: "rotated-token",
        accounts: [{ address: accountAddress }],
      }),
      signAndSendTransactions: jest.fn().mockImplementation(async () => {
        events.push("signed");
        return ["transaction-signature"];
      }),
    };
    mockTransact.mockImplementation(async (callback: (value: typeof wallet) => unknown) =>
      callback(wallet),
    );

    await expect(
      signAndSendTransaction(
        "old-token",
        new Transaction(),
        walletAddress,
        "phantom",
        async (authToken) => {
          expect(authToken).toBe("rotated-token");
          events.push("persisted");
        },
      ),
    ).resolves.toEqual({ signature: "transaction-signature", authToken: "rotated-token" });
    expect(events).toEqual(["persisted", "signed"]);
  });
});
