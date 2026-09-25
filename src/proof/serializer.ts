// Encode Groth16 proof points and public inputs for the Solana verifier.
// G1 proof A uses a negated y-coordinate. G2 coordinates use c1 before c0.

import {
  BN254_BASE_FIELD,
  NUM_PUBLIC_INPUTS,
  PROOF_A_SIZE,
  PROOF_B_SIZE,
  PROOF_C_SIZE,
  TOTAL_PROOF_SIZE,
} from "./constants";
import type { RawProof, SolanaProof } from "./types";
import { canonicalScalar } from "./request";

function unsignedInteger(value: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Expected a canonical unsigned decimal integer.");
  }
  if (value.length > 78) throw new Error("Integer exceeds 256 bits.");
  const integer = BigInt(value);
  if (integer >= 1n << 256n) throw new Error("Integer exceeds 256 bits.");
  return integer;
}

/** Encode a canonical unsigned decimal integer without truncation. */
export function toBigEndian32(decStr: string): Uint8Array {
  let n = unsignedInteger(decStr);
  const bytes = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    bytes[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return bytes;
}

function baseFieldCoordinate(value: string): bigint {
  const coordinate = unsignedInteger(value);
  if (coordinate >= BN254_BASE_FIELD) {
    throw new Error("Proof coordinate is outside the curve base field.");
  }
  return coordinate;
}

function coordinateBytes(value: string): Uint8Array {
  return toBigEndian32(baseFieldCoordinate(value).toString());
}

function negateG1Y(value: string): Uint8Array {
  const coordinate = baseFieldCoordinate(value);
  return toBigEndian32((coordinate === 0n ? 0n : BN254_BASE_FIELD - coordinate).toString());
}

/** Encode proof points and the selected generation's public inputs. */
export function serializeProof(
  proof: RawProof,
  publicSignals: string[],
  generation: "legacy" | "request-bound-v1" = "legacy",
): SolanaProof {
  if (proof.protocol !== "groth16" || proof.curve !== "bn128") {
    throw new Error("Expected a BN254 Groth16 proof.");
  }
  for (const point of [proof.pi_a, proof.pi_c]) {
    if (
      !Array.isArray(point) ||
      ![2, 3].includes(point.length) ||
      (point.length === 3 && point[2] !== "1")
    ) {
      throw new Error("Expected an affine G1 proof point.");
    }
  }
  if (
    !Array.isArray(proof.pi_b) ||
    ![2, 3].includes(proof.pi_b.length) ||
    proof.pi_b.some((row) => !Array.isArray(row) || row.length !== 2) ||
    (proof.pi_b.length === 3 && (proof.pi_b[2]?.[0] !== "1" || proof.pi_b[2]?.[1] !== "0"))
  ) {
    throw new Error("Expected an affine G2 proof point.");
  }
  const expected = generation === "request-bound-v1" ? 6 : NUM_PUBLIC_INPUTS;
  if (publicSignals.length !== expected) {
    throw new Error(`Expected ${expected} public signals, got ${publicSignals.length}`);
  }
  if (
    generation === "request-bound-v1" &&
    publicSignals.slice(4).some((value) => BigInt(value) >= 1n << 128n)
  ) {
    throw new Error("The request digest limb is outside its encoded range.");
  }

  // proof_a: x (32 bytes) + negated y (32 bytes)
  const a0 = coordinateBytes(proof.pi_a[0]!);
  const a1 = negateG1Y(proof.pi_a[1]!);
  const proofA = new Uint8Array(PROOF_A_SIZE);
  proofA.set(a0, 0);
  proofA.set(a1, 32);

  // proof_b: G2 with reversed coordinate ordering (c1 before c0)
  const b00 = coordinateBytes(proof.pi_b[0]![1]!);
  const b01 = coordinateBytes(proof.pi_b[0]![0]!);
  const b10 = coordinateBytes(proof.pi_b[1]![1]!);
  const b11 = coordinateBytes(proof.pi_b[1]![0]!);
  const proofB = new Uint8Array(PROOF_B_SIZE);
  proofB.set(b00, 0);
  proofB.set(b01, 32);
  proofB.set(b10, 64);
  proofB.set(b11, 96);

  // proof_c: x + y (no negation)
  const c0 = coordinateBytes(proof.pi_c[0]!);
  const c1 = coordinateBytes(proof.pi_c[1]!);
  const proofC = new Uint8Array(PROOF_C_SIZE);
  proofC.set(c0, 0);
  proofC.set(c1, 32);

  // Combine into a single 256-byte blob
  const proofBytes = new Uint8Array(TOTAL_PROOF_SIZE);
  proofBytes.set(proofA, 0);
  proofBytes.set(proofB, PROOF_A_SIZE);
  proofBytes.set(proofC, PROOF_A_SIZE + PROOF_B_SIZE);

  // Public inputs as 32-byte big-endian arrays
  const publicInputs = publicSignals.map(canonicalScalar);

  return { proofBytes, publicInputs };
}
