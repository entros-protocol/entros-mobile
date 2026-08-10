import { loadBaseline, persistPreparedBaseline, prepareBaseline } from "../baseline";

const mockSecureValues = new Map<string, string>();

jest.mock("@/storage/secure", () => ({
  SecureKeys: {
    BASELINE_ENVELOPE: "baseline.envelope",
    BASELINE_KEY: "baseline.key",
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

const baseline = {
  fingerprint: Array.from({ length: 256 }, (_, index) => index % 2),
  salt: "123",
  commitment: "456",
  timestamp: 1_777_777_777_000,
  projectionVersion: 1,
};

describe("versioned mobile baseline persistence", () => {
  beforeEach(() => mockSecureValues.clear());

  test("does not replace the stored envelope until persistence is explicit", async () => {
    mockSecureValues.set("baseline.envelope", "previous-envelope");

    const prepared = await prepareBaseline(baseline);

    expect(mockSecureValues.get("baseline.envelope")).toBe("previous-envelope");
    await persistPreparedBaseline(prepared);
    expect(mockSecureValues.get("baseline.envelope")).toBe(prepared.serializedEnvelope);
    await expect(loadBaseline()).resolves.toEqual(baseline);
  });

  test("maps an older baseline without a version to projection zero", async () => {
    const prepared = await prepareBaseline({
      ...baseline,
      projectionVersion: undefined as unknown as number,
    });
    await persistPreparedBaseline(prepared);

    await expect(loadBaseline()).resolves.toMatchObject({ projectionVersion: 0 });
  });
});
