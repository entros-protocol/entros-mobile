import { bytesToHex } from "@noble/hashes/utils.js";

import { attestationDigest } from "@/paired";
import { bytes, vectors } from "@/paired/__tests__/vectors";

import { EntrosPlayIntegrity } from "../../../modules/entros-play-integrity";
import { tokenFor, warm } from "../playIntegrity";

// jest.setup.ts replaces the native module with these mocks.
jest.mock("@/config", () => ({ config: { playIntegrityCloudProjectNumber: 123456789012 } }));
jest.mock("@/lib/log", () => ({ devWarn: jest.fn() }));

const native = EntrosPlayIntegrity!;
const prepare = jest.mocked(native.prepare);
const request = jest.mocked(native.request);

const vector = vectors.attestation[0]!;
const digestHex = bytesToHex(
  attestationDigest({
    protocolVersion: vector.protocolVersion,
    sessionNonce: bytes(vector.sessionNonceHex),
    attemptBinding: bytes(vector.attemptBindingDigestHex),
    finalDigest: bytes(vector.finalDigestHex),
    projectionVersion: vector.projectionVersion,
  }),
);

beforeEach(() => {
  prepare.mockReset().mockResolvedValue(undefined);
  request.mockReset();
  jest.useRealTimers();
});

describe("Play Integrity tokens", () => {
  test("requests the token over the exact lowercase digest hex", async () => {
    expect(digestHex).toBe(vector.requestHash);
    request.mockResolvedValueOnce("integrity-token");
    await expect(tokenFor(digestHex)).resolves.toBe("integrity-token");
    expect(prepare).toHaveBeenCalledWith(123456789012);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(vector.requestHash);
  });

  test("returns null, never throws, when Play fails", async () => {
    request.mockRejectedValueOnce(new Error("Play Integrity failed (code -3)."));
    await expect(tokenFor(digestHex)).resolves.toBeNull();
    prepare.mockRejectedValueOnce(new Error("Play Integrity failed (code -12)."));
    await expect(tokenFor(digestHex)).resolves.toBeNull();
    request.mockResolvedValueOnce("");
    await expect(tokenFor(digestHex)).resolves.toBeNull();
  });

  test("returns null once the timeout passes", async () => {
    jest.useFakeTimers();
    request.mockReturnValueOnce(new Promise<string>(() => undefined));
    const token = tokenFor(digestHex, 4_000);
    await jest.advanceTimersByTimeAsync(4_000);
    await expect(token).resolves.toBeNull();
  });

  test("refuses anything but a 32-byte lowercase hex digest", async () => {
    await expect(tokenFor(digestHex.toUpperCase())).resolves.toBeNull();
    await expect(tokenFor(digestHex.slice(2))).resolves.toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  test("warm prepares the provider and swallows a failure", async () => {
    prepare.mockRejectedValueOnce(new Error("offline"));
    expect(() => warm()).not.toThrow();
    await Promise.resolve();
    expect(prepare).toHaveBeenCalledWith(123456789012);
  });
});

describe("without the native module or a project number", () => {
  // Both mocks are plain objects the service reads at call time.
  const moduleExports = jest.requireMock<{
    EntrosPlayIntegrity: typeof EntrosPlayIntegrity;
  }>("../../../modules/entros-play-integrity");
  const configExports = jest.requireMock<{
    config: { playIntegrityCloudProjectNumber: number | null };
  }>("@/config");

  test("resolves null without calling Play when the module is absent", async () => {
    moduleExports.EntrosPlayIntegrity = null;
    try {
      await expect(tokenFor(digestHex)).resolves.toBeNull();
      expect(() => warm()).not.toThrow();
    } finally {
      moduleExports.EntrosPlayIntegrity = native;
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  test("resolves null without calling Play when no project number is set", async () => {
    configExports.config.playIntegrityCloudProjectNumber = null;
    try {
      await expect(tokenFor(digestHex)).resolves.toBeNull();
      warm();
    } finally {
      configExports.config.playIntegrityCloudProjectNumber = 123456789012;
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
