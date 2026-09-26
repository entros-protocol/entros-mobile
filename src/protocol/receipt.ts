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
   * version 3.
   */
  message_hex: string;
  /** Hex-encoded 64-byte Ed25519 signature over `message_hex`. */
  signature_hex: string;
}

export type ReceiptVersion = 2 | 3;

/**
 * Decoded byte form of a `SignedReceiptDto`. `null` from `decodeSignedReceipt`
 * means the caller must stop the receipt-bound flow.
 */
export interface DecodedReceipt {
  publicKey: Uint8Array;
  signature: Uint8Array;
  message: Uint8Array;
  version: ReceiptVersion;
  /** The paired session's final digest. Version 3 only. */
  finalDigest: Uint8Array | null;
  /** 0 open, 1 bound, 2 attested. Version 3 only. */
  assuranceTier: number | null;
}

/**
 * Expected byte lengths for the receipt's three hex-encoded fields. Pinned
 * at the wire format defined by `entros_validation::receipts` and verified
 * on-chain by entros-anchor.
 *
 * Pubkey: Ed25519 public key (32B). Signature: Ed25519 signature (64B).
 * A version 2 message holds the domain (28), purpose (1), projection version
 * (2), wallet (32), commitment (32), and validation time (8). A version 3
 * message keeps those offsets under its own domain and appends the paired
 * session's final digest (32) and its assurance tier (1). Each version has
 * its own domain, so no signed message parses under two layouts.
 */
const PUBKEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const V2_MESSAGE_BYTES = 103;
const V3_MESSAGE_BYTES = 136;
const DOMAIN_BYTES = 28;
const RECEIPT_DOMAIN_V2 = new TextEncoder().encode("entros-validator-receipt-v2\0");
const RECEIPT_DOMAIN_V3 = new TextEncoder().encode("entros-validator-receipt-v3\0");
const FINAL_DIGEST_OFFSET = 103;
const ASSURANCE_TIER_OFFSET = 135;
/** 0 open, 1 bound, 2 attested. The program rejects any other value. */
const MAX_ASSURANCE_TIER = 2;

const HEX_RE = /^[0-9a-fA-F]+$/;

export type ReceiptPurpose = 1 | 2 | 3;

export interface ReceiptBinding {
  purpose: ReceiptPurpose;
  projectionVersion: number;
  wallet: Uint8Array;
  commitment: Uint8Array;
  /**
   * The paired session this receipt must have consumed. When present, only a
   * version 3 receipt carrying this digest matches.
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
  const version: ReceiptVersion | null =
    messageHexLength === V2_MESSAGE_BYTES * 2
      ? 2
      : messageHexLength === V3_MESSAGE_BYTES * 2
        ? 3
        : null;
  if (!publicKey || !signature || version === null) return null;
  const message = hexToBytes(
    receipt.message_hex,
    version === 2 ? V2_MESSAGE_BYTES : V3_MESSAGE_BYTES,
  );
  if (!message) return null;
  const domain = version === 2 ? RECEIPT_DOMAIN_V2 : RECEIPT_DOMAIN_V3;
  if (!equalBytes(message.subarray(0, DOMAIN_BYTES), domain)) return null;
  if (version === 2) {
    return { publicKey, signature, message, version, finalDigest: null, assuranceTier: null };
  }
  const assuranceTier = message[ASSURANCE_TIER_OFFSET]!;
  if (assuranceTier > MAX_ASSURANCE_TIER) return null;
  return {
    publicKey,
    signature,
    message,
    version,
    finalDigest: message.slice(FINAL_DIGEST_OFFSET, ASSURANCE_TIER_OFFSET),
    assuranceTier,
  };
}

/** Check the signed message fields before a wallet submits the transition. */
export function receiptMatchesBinding(receipt: SignedReceiptDto, binding: ReceiptBinding): boolean {
  const decoded = decodeSignedReceipt(receipt);
  if (!decoded) return false;
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
 * Build the Ed25519 verification instruction for a mint, rebaseline or reset
 * receipt.
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
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey: decoded.publicKey,
    message: decoded.message,
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
