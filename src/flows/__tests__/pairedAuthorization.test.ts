import { PairedServiceError } from "@/services/pairedErrors";
import type { GrantedPairedAuthorization } from "@/services/pairedExecutor";
import {
  dropPairedAuthorization,
  usablePairedAuthorization,
} from "@/state/pairedAuthorizationBuffer";
import type * as mwa from "@/wallet/mwa";

import { ensurePairedAuthorization } from "../pairedAuthorization";
import { WalletSession } from "@/wallet/session";

jest.mock("@/config", () => ({ config: { relayerUrl: "https://executor.test" } }));
jest.mock("@/wallet/mwa", () => ({ signMessage: jest.fn() }));

const WALLET = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const CHALLENGE = "22".repeat(32);
const EXPIRES_AT = 1_800_000_000;

/** Both clocks advanced by the same amount from zero. */
const at = (ms: number) => ({ monotonicMs: ms, wallMs: ms });

const granted = (requestedAtMs = 0): GrantedPairedAuthorization => ({
  grant: {
    challenge: CHALLENGE,
    expiresAt: EXPIRES_AT,
    expiresInSecs: 900,
    origin: "4b".repeat(16),
    mac: "92".repeat(32),
  },
  requestedAt: at(requestedAtMs),
});

function setup() {
  const persisted: string[] = [];
  const wallet = new WalletSession(WALLET, "phantom", "token-1", async (token) => {
    persisted.push(token);
    return true;
  });
  const requestGrant = jest.fn(async () => granted());
  const signMessage = jest.fn<
    ReturnType<typeof mwa.signMessage>,
    Parameters<typeof mwa.signMessage>
  >(async () => ({ signature: new Uint8Array(64).fill(0xcb), authToken: "token-2" }));
  let nowMs = 0;
  return {
    wallet,
    persisted,
    requestGrant,
    signMessage,
    deps: { requestGrant, signMessage, now: () => at(nowMs) },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

beforeEach(() => dropPairedAuthorization());

describe("paired authorization before a capture", () => {
  test("has the wallet sign the relayer's challenge once and holds the result", async () => {
    const { wallet, requestGrant, signMessage, deps } = setup();
    const outcome = await ensurePairedAuthorization(wallet, deps);
    if (outcome.kind !== "ready" || !outcome.authorization) throw new Error("expected a signature");

    expect(requestGrant).toHaveBeenCalledWith(WALLET);
    const [token, message, address, kind] = signMessage.mock.calls[0]!;
    expect(token).toBe("token-1");
    expect(address).toBe(WALLET);
    expect(kind).toBe("phantom");
    // The app builds the text from the grant's fields.
    expect(new TextDecoder().decode(message)).toBe(
      "Entros verification\n" +
        "Sign to start verification sessions for this wallet. The authorization expires within the hour. It moves no funds and approves no transaction.\n" +
        `\nEntros-Paired-Open-v1\nwallet:${WALLET}\nchallenge:${CHALLENGE}\nexpires:${EXPIRES_AT}`,
    );
    expect(outcome.authorization.signatureHex).toBe("cb".repeat(64));
    expect(outcome.authorization.lifetimeMs).toBe(900_000);
    expect(outcome.authorization.requestedAt).toEqual(at(0));
    // The session keeps the token the wallet rotated to.
    expect(wallet.authToken).toBe("token-2");
    expect(usablePairedAuthorization(WALLET, at(0))).toBe(outcome.authorization);
  });

  test("serves the next session from the held authorization, with no request and no prompt", async () => {
    const { wallet, requestGrant, signMessage, deps, advance } = setup();
    const first = await ensurePairedAuthorization(wallet, deps);
    advance(600_000);
    const second = await ensurePairedAuthorization(wallet, deps);
    expect(second).toEqual(first);
    expect(requestGrant).toHaveBeenCalledTimes(1);
    expect(signMessage).toHaveBeenCalledTimes(1);
  });

  test("asks again once the held authorization is inside its margin of expiry", async () => {
    const { wallet, requestGrant, signMessage, deps, advance } = setup();
    await ensurePairedAuthorization(wallet, deps);
    advance(780_001);
    requestGrant.mockResolvedValueOnce(granted(780_001));
    await ensurePairedAuthorization(wallet, deps);
    expect(requestGrant).toHaveBeenCalledTimes(2);
    expect(signMessage).toHaveBeenCalledTimes(2);
  });

  test("asks another wallet to sign for itself", async () => {
    const { wallet, requestGrant, deps } = setup();
    await ensurePairedAuthorization(wallet, deps);
    const other = new WalletSession(
      "11111111111111111111111111111111",
      "solflare",
      "other-token",
      async () => true,
    );
    await ensurePairedAuthorization(other, deps);
    expect(requestGrant).toHaveBeenLastCalledWith("11111111111111111111111111111111");
    expect(usablePairedAuthorization(WALLET, at(0))).toBeNull();
  });

  test("opens without an authorization on a relayer that has no route for one", async () => {
    const { wallet, requestGrant, signMessage, deps } = setup();
    requestGrant.mockRejectedValueOnce(
      new PairedServiceError({ reason: "unsupported_session", status: 404 }),
    );
    expect(await ensurePairedAuthorization(wallet, deps)).toEqual({
      kind: "ready",
      authorization: null,
    });
    expect(signMessage).not.toHaveBeenCalled();
  });

  test("reports a refused request and holds nothing", async () => {
    const { wallet, requestGrant, signMessage, deps } = setup();
    requestGrant.mockRejectedValueOnce(
      new PairedServiceError({ reason: "ip_rate_limited", status: 429, retryAfterSec: 9 }),
    );
    expect(await ensurePairedAuthorization(wallet, deps)).toEqual({
      kind: "failed",
      failure: { reason: "ip_rate_limited", status: 429, retryAfterSec: 9 },
    });
    expect(signMessage).not.toHaveBeenCalled();
    expect(usablePairedAuthorization(WALLET, at(0))).toBeNull();
  });

  test("reports a person who declined in the wallet and holds nothing", async () => {
    const { wallet, signMessage, deps } = setup();
    signMessage.mockRejectedValueOnce(new Error("User rejected the request."));
    expect(await ensurePairedAuthorization(wallet, deps)).toEqual({ kind: "declined" });
    expect(wallet.authToken).toBe("token-1");
    expect(usablePairedAuthorization(WALLET, at(0))).toBeNull();
  });

  test("tells a wallet that could not sign apart from a refusal", async () => {
    const { wallet, signMessage, deps } = setup();
    signMessage.mockRejectedValueOnce(
      new Error("Validation wallet does not match the connected wallet."),
    );
    expect(await ensurePairedAuthorization(wallet, deps)).toEqual({
      kind: "wallet-failed",
      message: "Validation wallet does not match the connected wallet.",
    });
    expect(usablePairedAuthorization(WALLET, at(0))).toBeNull();
  });

  test("reports a wallet that never answered the prompt", async () => {
    const { wallet, signMessage, deps } = setup();
    const timeout = new Error("The wallet did not respond in time.");
    timeout.name = "MWATimeoutError";
    signMessage.mockRejectedValueOnce(timeout);
    expect(await ensurePairedAuthorization(wallet, deps)).toEqual({ kind: "wallet-unresponsive" });
    expect(usablePairedAuthorization(WALLET, at(0))).toBeNull();
  });

  test("holds nothing when the prompt used up the lifetime", async () => {
    const { wallet, signMessage, deps, advance } = setup();
    signMessage.mockImplementationOnce(async () => {
      advance(800_000);
      return { signature: new Uint8Array(64), authToken: "token-2" };
    });
    expect(await ensurePairedAuthorization(wallet, deps)).toEqual({ kind: "expired" });
    expect(usablePairedAuthorization(WALLET, at(800_000))).toBeNull();
  });

  test("counts wall time the monotonic clock missed while the wallet prompt was open", async () => {
    const { wallet, signMessage, requestGrant, deps } = setup();
    let reading = at(0);
    requestGrant.mockResolvedValueOnce({ ...granted(), requestedAt: reading });
    signMessage.mockImplementationOnce(async () => {
      // The device slept: wall time moved 800 s, the monotonic clock did not.
      reading = { monotonicMs: 0, wallMs: 800_000 };
      return { signature: new Uint8Array(64), authToken: "token-2" };
    });
    expect(await ensurePairedAuthorization(wallet, { ...deps, now: () => reading })).toEqual({
      kind: "expired",
    });
  });
});
