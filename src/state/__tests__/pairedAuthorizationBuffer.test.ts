import type { PairedAuthorization } from "@/paired";

import {
  dropPairedAuthorization,
  holdPairedAuthorization,
  usablePairedAuthorization,
} from "../pairedAuthorizationBuffer";

const WALLET = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const OTHER_WALLET = "11111111111111111111111111111111";
const NOW = { monotonicMs: 0, wallMs: 0 };

const authorization = (challenge: string): PairedAuthorization => ({
  wallet: WALLET,
  challenge,
  expiresAt: 1_800_000_000,
  origin: "4b".repeat(16),
  mac: "92".repeat(32),
  signatureHex: "cb".repeat(64),
  lifetimeMs: 900_000,
  requestedAt: NOW,
});

beforeEach(() => dropPairedAuthorization());

describe("held paired authorization", () => {
  test("a refusal drops only the authorization its request sent", () => {
    const current = authorization("33".repeat(32));
    holdPairedAuthorization(current);

    // A refusal of an earlier authorization leaves the newer one in place.
    dropPairedAuthorization(WALLET, "22".repeat(32));
    expect(usablePairedAuthorization(WALLET, NOW)).toBe(current);
    dropPairedAuthorization(OTHER_WALLET, current.challenge);
    expect(usablePairedAuthorization(WALLET, NOW)).toBe(current);

    dropPairedAuthorization(WALLET, current.challenge);
    expect(usablePairedAuthorization(WALLET, NOW)).toBeNull();
  });

  test("drops any held authorization when asked without a wallet", () => {
    holdPairedAuthorization(authorization("33".repeat(32)));
    dropPairedAuthorization();
    expect(usablePairedAuthorization(WALLET, NOW)).toBeNull();
  });
});
