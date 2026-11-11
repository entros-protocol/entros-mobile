import { bigintToBytes32 } from "@/hashing";

import { deleteSecure, getSecure } from "@/storage/secure";

import {
  loadBaseline,
  persistPreparedBaseline,
  prepareBaseline,
  wipeBaseline,
  type BaselineScope,
} from "../baseline";

const mockSecureValues = new Map<string, string>();

jest.mock("@/storage/secure", () => ({
  SecureKeys: {
    LEGACY_BASELINE_ENVELOPE: "baseline.envelope",
    LEGACY_BASELINE_KEY: "baseline.key",
  },
  getSecure: jest.fn(async (key: string) => mockSecureValues.get(key) ?? null),
  setSecure: jest.fn(async (key: string, value: string) => {
    mockSecureValues.set(key, value);
  }),
  deleteSecure: jest.fn(async (key: string) => {
    mockSecureValues.delete(key);
  }),
}));

jest.mock("@noble/ciphers/aes.js", () => ({
  gcm: () => ({
    encrypt: (bytes: Uint8Array) => bytes,
    decrypt: (bytes: Uint8Array) => bytes,
  }),
}));

jest.mock("@noble/ciphers/utils.js", () => ({
  randomBytes: (length: number) => new Uint8Array(length).fill(7),
  bytesToHex: (bytes: Uint8Array) =>
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  hexToBytes: (hex: string) =>
    Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
      Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
    ),
}));

const WALLET_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const WALLET_B = "SysvarRent111111111111111111111111111111111";
const scopeA: BaselineScope = { cluster: "devnet", wallet: WALLET_A };
const scopeB: BaselineScope = { cluster: "devnet", wallet: WALLET_B };

const baseline = {
  fingerprint: Array.from({ length: 256 }, (_, index) => index % 2),
  salt: "123",
  commitment: "456",
  timestamp: 1_777_777_777_000,
  projectionVersion: 1,
};
const otherBaseline = { ...baseline, salt: "789", commitment: "1011" };
const chain = (commitment: string) => bigintToBytes32(BigInt(commitment));

/** An envelope the earlier app wrote under the single unscoped entry. */
function seedLegacy(stored: typeof baseline): void {
  mockSecureValues.set(
    "baseline.envelope",
    JSON.stringify({
      v: 1,
      iv: "07".repeat(12),
      ct: Buffer.from(JSON.stringify(stored)).toString("hex"),
    }),
  );
  mockSecureValues.set("baseline.key", "07".repeat(32));
}

describe("versioned mobile baseline persistence", () => {
  beforeEach(() => mockSecureValues.clear());

  test("does not replace the stored envelope until persistence is explicit", async () => {
    await persistPreparedBaseline(await prepareBaseline(scopeA, otherBaseline));
    const previous = await loadBaseline(scopeA, chain(otherBaseline.commitment));

    const prepared = await prepareBaseline(scopeA, baseline);

    await expect(loadBaseline(scopeA, chain(otherBaseline.commitment))).resolves.toEqual(previous);
    await persistPreparedBaseline(prepared);
    await expect(loadBaseline(scopeA, chain(baseline.commitment))).resolves.toEqual(baseline);
  });

  test("maps an older baseline without a version to projection zero", async () => {
    const prepared = await prepareBaseline(scopeA, {
      ...baseline,
      projectionVersion: undefined as unknown as number,
    });
    await persistPreparedBaseline(prepared);

    await expect(loadBaseline(scopeA, chain(baseline.commitment))).resolves.toMatchObject({
      projectionVersion: 0,
    });
  });
});

describe("baseline scope", () => {
  beforeEach(() => mockSecureValues.clear());

  test("keeps a separate baseline for each wallet", async () => {
    await persistPreparedBaseline(await prepareBaseline(scopeA, baseline));
    await persistPreparedBaseline(await prepareBaseline(scopeB, otherBaseline));

    await expect(loadBaseline(scopeA, chain(baseline.commitment))).resolves.toEqual(baseline);
    await expect(loadBaseline(scopeB, chain(otherBaseline.commitment))).resolves.toEqual(
      otherBaseline,
    );
  });

  test("keeps a separate baseline for each cluster", async () => {
    await persistPreparedBaseline(await prepareBaseline(scopeA, baseline));

    await expect(
      loadBaseline({ cluster: "testnet", wallet: WALLET_A }, chain(baseline.commitment)),
    ).resolves.toBeNull();
  });

  test("returns nothing when the stored commitment differs from the chain", async () => {
    await persistPreparedBaseline(await prepareBaseline(scopeA, baseline));

    await expect(loadBaseline(scopeA, chain(otherBaseline.commitment))).resolves.toBeNull();
    // The entry survives for a later chain read that matches it.
    await expect(loadBaseline(scopeA, chain(baseline.commitment))).resolves.toEqual(baseline);
  });

  test("moves an unscoped baseline to the wallet whose chain commitment it matches", async () => {
    seedLegacy(baseline);

    await expect(loadBaseline(scopeB, chain(otherBaseline.commitment))).resolves.toBeNull();
    expect(mockSecureValues.has("baseline.envelope")).toBe(true);
    expect(mockSecureValues.has("baseline.key")).toBe(true);

    await expect(loadBaseline(scopeA, chain(baseline.commitment))).resolves.toEqual(baseline);
    expect(mockSecureValues.has("baseline.envelope")).toBe(false);
    expect(mockSecureValues.has("baseline.key")).toBe(false);
    await expect(loadBaseline(scopeA, chain(baseline.commitment))).resolves.toEqual(baseline);
  });

  test("leaves an unscoped baseline alone when the wallet's own entry matches", async () => {
    await persistPreparedBaseline(await prepareBaseline(scopeA, otherBaseline));
    seedLegacy(baseline);

    await expect(loadBaseline(scopeA, chain(otherBaseline.commitment))).resolves.toEqual(
      otherBaseline,
    );
    expect(mockSecureValues.has("baseline.envelope")).toBe(true);
  });

  test("replaces a stale own baseline with a matching unscoped one", async () => {
    await persistPreparedBaseline(await prepareBaseline(scopeA, otherBaseline));
    seedLegacy(baseline);

    await expect(loadBaseline(scopeA, chain(baseline.commitment))).resolves.toEqual(baseline);
    expect(mockSecureValues.has("baseline.envelope")).toBe(false);
    await expect(loadBaseline(scopeA, chain(baseline.commitment))).resolves.toEqual(baseline);
  });

  test("replaces a stale own baseline with the matching one of the wallet it migrated from", async () => {
    await persistPreparedBaseline(await prepareBaseline(scopeB, otherBaseline));
    await persistPreparedBaseline(await prepareBaseline(scopeA, baseline));
    const envelopeA = mockSecureValues.get(`baseline.devnet.${WALLET_A}.envelope`);

    await expect(loadBaseline(scopeB, chain(baseline.commitment), WALLET_A)).resolves.toEqual(
      baseline,
    );
    expect(mockSecureValues.get(`baseline.devnet.${WALLET_B}.envelope`)).toBe(envelopeA);
    await expect(loadBaseline(scopeB, chain(baseline.commitment))).resolves.toEqual(baseline);
  });

  test("keeps a stale own baseline when nothing else matches", async () => {
    await persistPreparedBaseline(await prepareBaseline(scopeB, otherBaseline));

    await expect(loadBaseline(scopeB, chain(baseline.commitment), WALLET_A)).resolves.toBeNull();
    await expect(loadBaseline(scopeB, chain(otherBaseline.commitment))).resolves.toEqual(
      otherBaseline,
    );
  });

  test("wipes one wallet's baseline and its unscoped entry, never another wallet's", async () => {
    await persistPreparedBaseline(await prepareBaseline(scopeA, baseline));
    await persistPreparedBaseline(await prepareBaseline(scopeB, otherBaseline));
    seedLegacy(baseline);

    await wipeBaseline(scopeA, chain(baseline.commitment));

    await expect(loadBaseline(scopeA, chain(baseline.commitment))).resolves.toBeNull();
    expect(mockSecureValues.has("baseline.envelope")).toBe(false);
    expect(mockSecureValues.has("baseline.key")).toBe(false);
    await expect(loadBaseline(scopeB, chain(otherBaseline.commitment))).resolves.toEqual(
      otherBaseline,
    );
  });

  test("keeps another wallet's unscoped baseline through a reset", async () => {
    seedLegacy(baseline);

    await wipeBaseline(scopeB, chain(otherBaseline.commitment));

    expect(mockSecureValues.has("baseline.envelope")).toBe(true);
    expect(mockSecureValues.has("baseline.key")).toBe(true);
    await expect(loadBaseline(scopeA, chain(baseline.commitment))).resolves.toEqual(baseline);
  });

  test("keeps the unscoped baseline when the wallet's chain commitment is unknown", async () => {
    await persistPreparedBaseline(await prepareBaseline(scopeA, otherBaseline));
    seedLegacy(baseline);

    await wipeBaseline(scopeA, null);

    await expect(loadBaseline(scopeA, chain(otherBaseline.commitment))).resolves.toBeNull();
    expect(mockSecureValues.has("baseline.envelope")).toBe(true);
    expect(mockSecureValues.has("baseline.key")).toBe(true);
  });

  test("with no wallet, wipes the unscoped entry and leaves every wallet's own", async () => {
    await persistPreparedBaseline(await prepareBaseline(scopeB, otherBaseline));
    seedLegacy(baseline);

    await wipeBaseline(null);

    await expect(loadBaseline(scopeA, chain(baseline.commitment))).resolves.toBeNull();
    await expect(loadBaseline(scopeB, chain(otherBaseline.commitment))).resolves.toEqual(
      otherBaseline,
    );
  });

  test("moves the baseline of the wallet an identity migrated from", async () => {
    await persistPreparedBaseline(await prepareBaseline(scopeA, baseline));
    const keyA = mockSecureValues.get(`baseline.devnet.${WALLET_A}.key`);
    const envelopeA = mockSecureValues.get(`baseline.devnet.${WALLET_A}.envelope`);

    await expect(loadBaseline(scopeB, chain(baseline.commitment), WALLET_A)).resolves.toEqual(
      baseline,
    );
    expect(mockSecureValues.get(`baseline.devnet.${WALLET_B}.key`)).toBe(keyA);
    expect(mockSecureValues.get(`baseline.devnet.${WALLET_B}.envelope`)).toBe(envelopeA);
    expect(mockSecureValues.has(`baseline.devnet.${WALLET_A}.key`)).toBe(false);
    expect(mockSecureValues.has(`baseline.devnet.${WALLET_A}.envelope`)).toBe(false);
    await expect(loadBaseline(scopeB, chain(baseline.commitment))).resolves.toEqual(baseline);
  });

  test("leaves the earlier wallet's baseline when it does not match the chain", async () => {
    await persistPreparedBaseline(await prepareBaseline(scopeA, otherBaseline));

    await expect(loadBaseline(scopeB, chain(baseline.commitment), WALLET_A)).resolves.toBeNull();
    await expect(loadBaseline(scopeA, chain(otherBaseline.commitment))).resolves.toEqual(
      otherBaseline,
    );
    expect(mockSecureValues.has(`baseline.devnet.${WALLET_B}.envelope`)).toBe(false);
  });

  test("reads the earlier wallet only on the same cluster", async () => {
    await persistPreparedBaseline(
      await prepareBaseline({ cluster: "testnet", wallet: WALLET_A }, baseline),
    );

    await expect(loadBaseline(scopeB, chain(baseline.commitment), WALLET_A)).resolves.toBeNull();
  });

  test("keeps the moved baseline when the earlier wallet's copy cannot be deleted", async () => {
    await persistPreparedBaseline(await prepareBaseline(scopeA, baseline));
    jest.mocked(deleteSecure).mockRejectedValueOnce(new Error("keystore busy"));

    await expect(loadBaseline(scopeB, chain(baseline.commitment), WALLET_A)).resolves.toEqual(
      baseline,
    );
    await expect(loadBaseline(scopeB, chain(baseline.commitment))).resolves.toEqual(baseline);
  });

  test("writes a new key when the stored key cannot be read and the caller allows it", async () => {
    const keyName = `baseline.devnet.${WALLET_A}.key`;
    mockSecureValues.set(keyName, "09".repeat(32));
    jest.mocked(getSecure).mockRejectedValueOnce(new Error("Could not decrypt the stored item."));

    const prepared = await prepareBaseline(scopeA, baseline, { replaceUnreadableKey: true });
    await persistPreparedBaseline(prepared);

    expect(mockSecureValues.get(keyName)).toBe("07".repeat(32));
    await expect(loadBaseline(scopeA, chain(baseline.commitment))).resolves.toEqual(baseline);
  });

  test("keeps a key it cannot read while the stored baseline is in use", async () => {
    const keyName = `baseline.devnet.${WALLET_A}.key`;
    mockSecureValues.set(keyName, "09".repeat(32));
    jest.mocked(getSecure).mockRejectedValueOnce(new Error("Could not decrypt the stored item."));

    await expect(prepareBaseline(scopeA, baseline)).rejects.toThrow("Could not decrypt");
    expect(mockSecureValues.get(keyName)).toBe("09".repeat(32));
  });

  test("never replaces a key it can read", async () => {
    const keyName = `baseline.devnet.${WALLET_A}.key`;
    mockSecureValues.set(keyName, "09".repeat(32));

    await prepareBaseline(scopeA, baseline, { replaceUnreadableKey: true });

    expect(mockSecureValues.get(keyName)).toBe("09".repeat(32));
  });

  test("a reset leaves nothing to adopt from the wallet the identity migrated from", async () => {
    await persistPreparedBaseline(await prepareBaseline(scopeA, baseline));

    await wipeBaseline(scopeB, chain(baseline.commitment));

    await expect(loadBaseline(scopeB, chain(baseline.commitment), WALLET_A)).resolves.toBeNull();
    expect(mockSecureValues.has(`baseline.devnet.${WALLET_A}.envelope`)).toBe(false);
    expect(mockSecureValues.has(`baseline.devnet.${WALLET_A}.key`)).toBe(false);
    expect(mockSecureValues.has(`baseline.devnet.${WALLET_B}.envelope`)).toBe(false);
  });

  test("a reset with an unknown commitment leaves no unscoped baseline to adopt", async () => {
    seedLegacy(baseline);

    await wipeBaseline(scopeB, null);
    expect(mockSecureValues.has("baseline.envelope")).toBe(true);

    await expect(loadBaseline(scopeB, chain(baseline.commitment))).resolves.toBeNull();
    expect(mockSecureValues.has("baseline.envelope")).toBe(false);
    expect(mockSecureValues.has("baseline.key")).toBe(false);
  });

  test("a reset leaves an entry that matches no chain commitment in place", async () => {
    seedLegacy(baseline);

    await wipeBaseline(scopeB, null);

    await expect(loadBaseline(scopeB, chain(otherBaseline.commitment))).resolves.toBeNull();
    expect(mockSecureValues.has("baseline.envelope")).toBe(true);
  });

  test("a reset for another commitment does not block adoption", async () => {
    await wipeBaseline(scopeB, chain(otherBaseline.commitment));
    await persistPreparedBaseline(await prepareBaseline(scopeA, baseline));

    await expect(loadBaseline(scopeB, chain(baseline.commitment), WALLET_A)).resolves.toEqual(
      baseline,
    );
  });

  test("storing a new baseline lifts the reset", async () => {
    await wipeBaseline(scopeB, null);
    expect(mockSecureValues.get(`baseline.devnet.${WALLET_B}.erased`)).toBe("*");

    await persistPreparedBaseline(await prepareBaseline(scopeB, otherBaseline));

    expect(mockSecureValues.has(`baseline.devnet.${WALLET_B}.erased`)).toBe(false);
    seedLegacy(baseline);
    await wipeBaseline(scopeA, null);
    await persistPreparedBaseline(await prepareBaseline(scopeA, otherBaseline));
    await expect(loadBaseline(scopeA, chain(baseline.commitment))).resolves.toEqual(baseline);
  });

  test("stores a new baseline when the reset marker cannot be removed", async () => {
    await wipeBaseline(scopeB, chain(baseline.commitment));
    expect(mockSecureValues.get(`baseline.devnet.${WALLET_B}.erased`)).toBe(
      Buffer.from(chain(baseline.commitment)).toString("hex"),
    );
    const prepared = await prepareBaseline(scopeB, otherBaseline);
    jest.mocked(deleteSecure).mockRejectedValueOnce(new Error("keystore busy"));

    await expect(persistPreparedBaseline(prepared)).resolves.toBeUndefined();
    await expect(loadBaseline(scopeB, chain(otherBaseline.commitment))).resolves.toEqual(
      otherBaseline,
    );
  });

  test("a reset marker never hides the wallet's own matching baseline", async () => {
    await persistPreparedBaseline(await prepareBaseline(scopeB, baseline));
    mockSecureValues.set(`baseline.devnet.${WALLET_B}.erased`, "*");

    await expect(loadBaseline(scopeB, chain(baseline.commitment))).resolves.toEqual(baseline);
  });

  test("refuses a scope that cannot name a secure-store entry", async () => {
    await expect(
      prepareBaseline({ cluster: "devnet", wallet: "not/a/wallet" }, baseline),
    ).rejects.toThrow();
    await expect(
      loadBaseline({ cluster: "dev net", wallet: WALLET_A }, chain(baseline.commitment)),
    ).rejects.toThrow();
  });
});
