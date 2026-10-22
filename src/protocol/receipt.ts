// Validator-signed receipt decoder + Ed25519 instruction builder.
// Mirrors pulse-sdk/src/submit/receipt.ts; the cross-platform receipt wire
// format is the contract enforced by entros-anchor's on-chain receipt parser.
//
// Lifecycle: validator signs (purpose, projection, wallet, commitment,
// validated_at, and for a paired session its final digest and assurance tier)
// → executor passes through → the app prepends an `Ed25519Program::verify`
// instruction before the receipt-bound instruction so the on-chain program can
// confirm the validator endorsed it via the Instructions sysvar. Decoded byte
// forms are derived per use and never persisted on the device. All three
// fields are public protocol artefacts.

import { sha256 } from "@noble/hashes/sha2.js";
import { Ed25519Program, type TransactionInstruction } from "@solana/web3.js";

import { equalBytes } from "@/lib/values";

/**
 * Validator-signed receipt binding the transition purpose and projection
 * version to the wallet, commitment, and validation time.
 * response when the request includes `commitment_new_hex` and the validator
 * has a signing key configured.
 *
 * Wire fields are byte-identical to `entros_validation::SignedReceiptDto`
 * and the executor's local mirror at `executor-node::validation::
 * SignedReceiptDto`. Hex strings are lowercase, no `0x` prefix — matches the
 * validator's `hex::encode` output exactly.
 */
export interface SignedReceiptDto {
  /** Hex-encoded 32-byte Ed25519 public key of the validator. */
  validator_pubkey_hex: string;
  /**
   * Hex-encoded receipt message: 103 bytes for version 2, 136 bytes for
   * versions 3 and 4 (for version 4 update receipts, `message_hex` is the
   * 136-byte preimage while `signature_hex` signs its 32-byte SHA-256 digest).
   */
  message_hex: string;
  /** Hex-encoded 64-byte Ed25519 signature over `message_hex` (or its SHA-256 digest for version 4). */
  signature_hex: string;
}

export type ReceiptVersion = 2 | 3 | 4;

/**
 * Decoded byte form of a `SignedReceiptDto`. `null` from `decodeSignedReceipt`
 * means the caller must stop the receipt-bound flow.
 */
export interface DecodedReceipt {
  publicKey: Uint8Array;
  signature: Uint8Array;
  message: Uint8Array;
  version: ReceiptVersion;
  validatedAt: bigint;
  /** The paired session's final digest, or `null` when zero/absent. */
  sessionFinalDigest: number[] | null;
  /** The paired session's final digest (raw 32-byte slice for versions 3 and 4). */
  finalDigest: Uint8Array | null;
  /** 0 open, 1 bound, 2 attested. Versions 3 and 4. */
  assuranceTier: number | null;
}

/**
 * Expected byte lengths for the receipt's three hex-encoded fields. Pinned
 * at the wire format defined by `entros_validation::receipts` and verified
 * on-chain by entros-anchor.
 *
 * Pubkey: Ed25519 public key (32B). Signature: Ed25519 signature (64B).
 * A version 2 message holds the domain (28), purpose (1), projection version
 * (2), wallet (32), commitment (32), and validation time (8). Versions 3 and 4
 * keep those offsets under their own domains and append the paired session's
 * final digest (32) and assurance tier (1). Version 4 signs the 32-byte
 * SHA-256 digest of its 136-byte preimage for `update_anchor*`.
 */
const PUBKEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const V2_MESSAGE_BYTES = 103;
const V3_MESSAGE_BYTES = 136;
const DOMAIN_BYTES = 28;
const RECEIPT_DOMAIN_V2 = new TextEncoder().encode("entros-validator-receipt-v2\0");
const RECEIPT_DOMAIN_V3 = new TextEncoder().encode("entros-validator-receipt-v3\0");
const RECEIPT_DOMAIN_V4 = new TextEncoder().encode("entros-validator-receipt-v4\0");
const VALIDATED_AT_OFFSET = 95;
const FINAL_DIGEST_OFFSET = 103;
const ASSURANCE_TIER_OFFSET = 135;
/** 0 open, 1 bound, 2 attested. The program rejects any other value. */
const MAX_ASSURANCE_TIER = 2;

const HEX_RE = /^[0-9a-fA-F]+$/;

export type ReceiptPurpose = 1 | 2 | 3 | 4;

export interface ReceiptBinding {
  purpose: ReceiptPurpose;
  projectionVersion: number;
  wallet: Uint8Array;
  commitment: Uint8Array;
  /**
   * The paired session this receipt must have consumed. When present, only a
   * version 3 or 4 receipt carrying this digest matches.
   */
  finalDigest?: Uint8Array;
}

function stripPrefix(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

/**
 * Decode a hex string into a Uint8Array of the expected byte length. Returns
 * `null` on malformed input (odd length, non-hex characters, wrong length).
 * Permissive about a leading `0x` because some integrations strip or
 * preserve it inconsistently.
 */
function hexToBytes(hex: string, expectedLen: number): Uint8Array | null {
  const trimmed = stripPrefix(hex);
  if (trimmed.length !== expectedLen * 2) return null;
  if (!HEX_RE.test(trimmed)) return null;
  const out = new Uint8Array(expectedLen);
  for (let i = 0; i < expectedLen; i += 1) {
    out[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Decode a `SignedReceiptDto` from hex strings into raw bytes. Returns `null`
 * if any field is malformed, including a domain that does not match the
 * message length or an unknown assurance tier. Callers should skip Ed25519 ix
 * construction in that case rather than building an ix the on-chain parser
 * will reject.
 */
export function decodeSignedReceipt(receipt: SignedReceiptDto): DecodedReceipt | null {
  const publicKey = hexToBytes(receipt.validator_pubkey_hex, PUBKEY_BYTES);
  const signature = hexToBytes(receipt.signature_hex, SIGNATURE_BYTES);
  const messageHexLength = stripPrefix(receipt.message_hex).length;
  if (
    !publicKey ||
    !signature ||
    (messageHexLength !== V2_MESSAGE_BYTES * 2 && messageHexLength !== V3_MESSAGE_BYTES * 2)
  ) {
    return null;
  }
  const message = hexToBytes(
    receipt.message_hex,
    messageHexLength === V2_MESSAGE_BYTES * 2 ? V2_MESSAGE_BYTES : V3_MESSAGE_BYTES,
  );
  if (!message) return null;
  const domainSlice = message.subarray(0, DOMAIN_BYTES);
  let version: ReceiptVersion | null = null;
  if (message.length === V2_MESSAGE_BYTES && equalBytes(domainSlice, RECEIPT_DOMAIN_V2)) {
    version = 2;
  } else if (message.length === V3_MESSAGE_BYTES && equalBytes(domainSlice, RECEIPT_DOMAIN_V3)) {
    version = 3;
  } else if (message.length === V3_MESSAGE_BYTES && equalBytes(domainSlice, RECEIPT_DOMAIN_V4)) {
    version = 4;
  }
  if (version === null) return null;
  const purpose = message[28]!;
  if (version === 4 ? purpose !== 4 : purpose < 1 || purpose > 3) return null;
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const validatedAt = view.getBigInt64(VALIDATED_AT_OFFSET, true);
  if (version === 2) {
    return {
      publicKey,
      signature,
      message,
      version,
      validatedAt,
      sessionFinalDigest: null,
      finalDigest: null,
      assuranceTier: null,
    };
  }
  const assuranceTier = message[ASSURANCE_TIER_OFFSET]!;
  if (assuranceTier > MAX_ASSURANCE_TIER) return null;
  const finalDigest = message.slice(FINAL_DIGEST_OFFSET, ASSURANCE_TIER_OFFSET);
  const hasNonZeroDigest = finalDigest.some((b) => b !== 0);
  return {
    publicKey,
    signature,
    message,
    version,
    validatedAt,
    sessionFinalDigest: hasNonZeroDigest ? Array.from(finalDigest) : null,
    finalDigest,
    assuranceTier,
  };
}

/** Check the signed message fields before a wallet submits the transition. */
export function receiptMatchesBinding(receipt: SignedReceiptDto, binding: ReceiptBinding): boolean {
  const decoded = decodeSignedReceipt(receipt);
  if (!decoded) return false;
  if ((binding.purpose === 4) !== (decoded.version === 4)) return false;
  if (
    binding.finalDigest &&
    !(decoded.finalDigest && equalBytes(decoded.finalDigest, binding.finalDigest))
  ) {
    return false;
  }
  const { message } = decoded;
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  return (
    message[28] === binding.purpose &&
    view.getUint16(29, true) === binding.projectionVersion &&
    equalBytes(message.subarray(31, 63), binding.wallet) &&
    equalBytes(message.subarray(63, 95), binding.commitment)
  );
}

/**
 * Build the Ed25519 verification instruction for a mint, rebaseline, reset, or
 * update receipt.
 *
 * Returns `null` if the receipt fails to decode. A first-verification caller
 * must stop instead of sending an unbound mint transaction.
 *
 * Web3.js's `Ed25519Program.createInstructionWithPublicKey` defaults the
 * three `*_instruction_index` fields to `0xFFFF`, the "current instruction"
 * sentinel the on-chain parser pins to. Cross-ix substitution attacks are
 * closed by that sentinel. We never build a receipt that points at another
 * ix's data.
 *
 * Synchronous because `@solana/web3.js` is bundled directly on mobile (vs
 * pulse-sdk's optional-peer-dep dynamic import). Saves a microtask boundary
 * in the first-verify hot path and lets `submit.ts` call this inline.
 */
export function buildEd25519ReceiptIx(receipt: SignedReceiptDto): TransactionInstruction | null {
  const decoded = decodeSignedReceipt(receipt);
  if (!decoded) return null;
  const signedBytes = decoded.version === 4 ? sha256(decoded.message) : decoded.message;
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: decoded.publicKey,
    message: signedBytes,
    signature: decoded.signature,
  });
}

/**
 * Build the receipt instruction required for a first verification.
 * Throws before wallet or RPC work when the receipt is absent or malformed.
 */
export function requireEd25519ReceiptIx(
  receipt: SignedReceiptDto | undefined,
): TransactionInstruction {
  if (!receipt) {
    throw new Error("First verification requires a validator-signed receipt.");
  }

  const instruction = buildEd25519ReceiptIx(receipt);
  if (!instruction) {
    throw new Error("The validator-signed receipt is malformed.");
  }

  return instruction;
}
