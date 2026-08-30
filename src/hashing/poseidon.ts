// Poseidon commitment over the BN254 scalar field. Same public API and
// algorithm as pulse-sdk/src/hashing/poseidon.ts; the only swap is the
// Poseidon backend — `poseidon-lite/poseidon3` (pure JS, zero deps) instead
// of `circomlibjs.buildPoseidon()` (Buffer-heavy via ffjavascript, breaks
// Metro/Hermes bundling). Both libraries advertise iden3-parity round
// constants + MDS matrix, so the bit-faithful contract holds against the
// web SDK. The parity test in `__tests__/parity.test.ts` is the gate.
//
// PRIVACY: this is the LAST function that holds the 256-bit fingerprint
// reference. Callers must drop their reference after `generateTBH` returns
// and forward only the 32-byte commitment + salt.

import { poseidon3 } from "poseidon-lite/poseidon3";

import { BN254_SCALAR_FIELD, FINGERPRINT_BITS } from "./constants";
import type { PackedFingerprint, TBH, TemporalFingerprint } from "./types";

/**
 * Pack 256-bit fingerprint into two 128-bit field elements.
 * Little-endian bit ordering within each chunk (matches circuit's Bits2Num).
 */
export function packBits(fingerprint: TemporalFingerprint): PackedFingerprint {
  let lo = BigInt(0);
  for (let i = 0; i < 128; i++) {
    if (fingerprint[i] === 1) {
      lo += BigInt(1) << BigInt(i);
    }
  }

  let hi = BigInt(0);
  for (let i = 0; i < 128; i++) {
    if (fingerprint[128 + i] === 1) {
      hi += BigInt(1) << BigInt(i);
    }
  }

  return { lo, hi };
}

/**
 * Compute Poseidon commitment: Poseidon(pack_lo, pack_hi, salt).
 * Matches the circuit's CommitmentCheck template exactly.
 *
 * Returns a Promise so the call site stays cross-platform symmetric with
 * the web SDK (which is genuinely async due to circomlibjs lazy init).
 */
export async function computeCommitment(
  fingerprint: TemporalFingerprint,
  salt: bigint,
): Promise<bigint> {
  if (fingerprint.length !== FINGERPRINT_BITS) {
    throw new Error(
      `computeCommitment expected ${FINGERPRINT_BITS}-bit fingerprint, got ${fingerprint.length}`,
    );
  }
  const { lo, hi } = packBits(fingerprint);
  return poseidon3([lo, hi, salt]);
}

/**
 * Generate a random salt within the BN254 scalar field. 31 bytes = 248 bits,
 * comfortably under the ~254-bit field, so the modulo is defensive belt-
 * and-braces rather than load-bearing.
 */
export function generateSalt(): bigint {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  let val = BigInt(0);
  for (let i = 0; i < bytes.length; i++) {
    val = (val << BigInt(8)) + BigInt(bytes[i] ?? 0);
  }
  return val % BN254_SCALAR_FIELD;
}

/**
 * Convert a BigInt to a 32-byte big-endian Uint8Array.
 */
export function bigintToBytes32(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let val = n;
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(val & BigInt(0xff));
    val >>= BigInt(8);
  }
  return bytes;
}

/**
 * Generate a complete TBH from a fingerprint.
 *
 * The returned `fingerprint` field is the same array reference passed in.
 * callers should drop their own reference and read from `tbh.fingerprint`
 * only when encrypting a baseline. Other paths retain only the commitment
 * and salt.
 */
export async function generateTBH(fingerprint: TemporalFingerprint, salt?: bigint): Promise<TBH> {
  const s = salt ?? generateSalt();
  const commitment = await computeCommitment(fingerprint, s);
  return {
    fingerprint,
    salt: s,
    commitment,
    commitmentBytes: bigintToBytes32(commitment),
  };
}
