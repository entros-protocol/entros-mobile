// The exact binary-fraction fixture passes through the feature-fusion boundary
// before projection. The web SDK test pins the same input and outputs.

import { bigintToBytes32, computeCommitment, generateTBH, packBits, simhash } from "../";
import { fuseFeatures } from "../../extraction/statistics";

const RAW_FIXTURE_FEATURES = Array.from({ length: 308 }, (_, i) => (((i * 37) % 211) - 105) / 64);
const FIXTURE_FEATURES = fuseFeatures(
  RAW_FIXTURE_FEATURES.slice(0, 170),
  RAW_FIXTURE_FEATURES.slice(170, 251),
  RAW_FIXTURE_FEATURES.slice(251),
);

const EXPECTED_PACKED_FINGERPRINT_HEX =
  "ce300e44e1f1cc2cf30784af4bd1ba165ced3560eb8a217c58d23f250239b237";
const EXPECTED_DISPLAY_FINGERPRINT_HEX =
  "730c7022878f3334cfe021f5d28b5d683ab7ac06d751843e1a4bfca4409c4dec";

const EXPECTED_PACKBITS_LO = 30213028142994471381011281194282528974n;
const EXPECTED_PACKBITS_HI = 74032924876321406520575610213660749148n;

const FIXED_SALT = 12345678901234567890123456789012345678901234567890n;

const EXPECTED_COMMITMENT_BIGINT =
  4408537286405000642682297592780026638927402242080165131288046914470862574756n;
const EXPECTED_COMMITMENT_HEX = "09bf24c82ec449df9367d90e1c55b6b178b4df54b7230269ad3f5e1973f6d4a4";

function packFingerprintBytes(bits: number[]): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bits.length; index += 1) {
    if (bits[index] === 1) {
      bytes[index >> 3] = (bytes[index >> 3] ?? 0) | (1 << (index & 7));
    }
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bitsToDisplayHex(bits: number[]): string {
  let output = "";
  for (let index = 0; index < bits.length; index += 4) {
    output += Number.parseInt(bits.slice(index, index + 4).join(""), 2).toString(16);
  }
  return output;
}

describe("hashing parity with projection version 1", () => {
  test("simhash produces the canonical packed 32-byte fingerprint", () => {
    const fp = simhash(FIXTURE_FEATURES, 1);
    expect(fp).toHaveLength(256);
    expect(bytesToHex(packFingerprintBytes(fp))).toBe(EXPECTED_PACKED_FINGERPRINT_HEX);
    // Display hex keeps bit 0 on the left. Witness bytes use little-endian
    // bit packing inside each byte, so the encodings differ by bit reversal.
    expect(bitsToDisplayHex(fp)).toBe(EXPECTED_DISPLAY_FINGERPRINT_HEX);
  });

  test("packBits splits fingerprint into the same lo/hi field elements", () => {
    const fp = simhash(FIXTURE_FEATURES, 1);
    const { lo, hi } = packBits(fp);
    expect(lo).toBe(EXPECTED_PACKBITS_LO);
    expect(hi).toBe(EXPECTED_PACKBITS_HI);
  });

  test("computeCommitment produces the same Poseidon output for fixed salt", async () => {
    const fp = simhash(FIXTURE_FEATURES, 1);
    const commitment = await computeCommitment(fp, FIXED_SALT);
    expect(commitment).toBe(EXPECTED_COMMITMENT_BIGINT);
  });

  test("bigintToBytes32 yields the expected 32-byte big-endian representation", async () => {
    const fp = simhash(FIXTURE_FEATURES, 1);
    const commitment = await computeCommitment(fp, FIXED_SALT);
    const bytes = bigintToBytes32(commitment);
    expect(bytes).toHaveLength(32);
    expect(bytesToHex(bytes)).toBe(EXPECTED_COMMITMENT_HEX);
  });

  test("generateTBH returns the same commitment when salt is supplied", async () => {
    const fp = simhash(FIXTURE_FEATURES, 1);
    const tbh = await generateTBH(fp, FIXED_SALT);
    expect(tbh.commitment).toBe(EXPECTED_COMMITMENT_BIGINT);
    expect(tbh.salt).toBe(FIXED_SALT);
    expect(bytesToHex(tbh.commitmentBytes)).toBe(EXPECTED_COMMITMENT_HEX);
  });

  test("generateTBH with random salt still produces a valid 32-byte commitment", async () => {
    const fp = simhash(FIXTURE_FEATURES, 1);
    const tbh = await generateTBH(fp);
    expect(typeof tbh.salt).toBe("bigint");
    expect(typeof tbh.commitment).toBe("bigint");
    expect(tbh.commitmentBytes).toHaveLength(32);
    // Random-salt round trip: bytes ↔ bigint must be lossless.
    const reconstructed = Array.from(tbh.commitmentBytes).reduce(
      (acc, b) => (acc << 8n) + BigInt(b),
      0n,
    );
    expect(reconstructed).toBe(tbh.commitment);
  });

  test("keeps direct callers on projection version 0 by default", () => {
    expect(simhash(FIXTURE_FEATURES)).toEqual(simhash(FIXTURE_FEATURES, 0));
    expect(simhash(FIXTURE_FEATURES)).not.toEqual(simhash(FIXTURE_FEATURES, 1));
  });
});
