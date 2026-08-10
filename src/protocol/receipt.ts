// Validator-signed mint receipt decoder + Ed25519 instruction builder.
// Mirrors pulse-sdk/src/submit/receipt.ts byte-for-byte; the cross-platform
// receipt wire format is the contract enforced by entros-anchor's on-chain
// `verify_mint_receipt`.
//
// Lifecycle: validator signs (wallet, commitment_new, validated_at) → executor
// passes through → SDK prepends an `Ed25519Program::verify` instruction
// before `mint_anchor` so the on-chain program can confirm the validator
// endorsed the mint via the Instructions sysvar. Decoded byte forms are
// derived once in `buildEd25519ReceiptIx` and never persisted on the device —
// all three fields are public protocol artefacts.

import { Ed25519Program, type TransactionInstruction } from "@solana/web3.js";

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
   * Hex-encoded 103-byte version 2 receipt message.
   */
  message_hex: string;
  /** Hex-encoded 64-byte Ed25519 signature over `message_hex`. */
  signature_hex: string;
}

/**
 * Decoded byte form of a `SignedReceiptDto`. `null` from `decodeSignedReceipt`
 * means the caller must stop the first-verification flow.
 */
export interface DecodedReceipt {
  publicKey: Uint8Array;
  signature: Uint8Array;
  message: Uint8Array;
}

/**
 * Expected byte lengths for the receipt's three hex-encoded fields. Pinned
 * at the wire format defined by `entros_validation::receipts` and verified
 * on-chain in `entros_anchor::verify_mint_receipt`.
 *
 * Pubkey: Ed25519 public key (32B). Signature: Ed25519 signature (64B).
 * Message: domain (28), purpose (1), projection version (2), wallet (32),
 * commitment (32), and validation time (8).
 */
const PUBKEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const MESSAGE_BYTES = 103;
const RECEIPT_DOMAIN = new TextEncoder().encode("entros-validator-receipt-v2\0");

const HEX_RE = /^[0-9a-fA-F]+$/;

export type ReceiptPurpose = 1 | 2 | 3;

export interface ReceiptBinding {
  purpose: ReceiptPurpose;
  projectionVersion: number;
  wallet: Uint8Array;
  commitment: Uint8Array;
}

/**
 * Decode a hex string into a Uint8Array of the expected byte length. Returns
 * `null` on malformed input (odd length, non-hex characters, wrong length).
 * Permissive about a leading `0x` because some integrations strip or
 * preserve it inconsistently.
 */
function hexToBytes(hex: string, expectedLen: number): Uint8Array | null {
  const trimmed = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
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
 * if any field is malformed — callers should skip Ed25519 ix construction in
 * that case rather than building an ix the on-chain parser will reject.
 */
export function decodeSignedReceipt(receipt: SignedReceiptDto): DecodedReceipt | null {
  const publicKey = hexToBytes(receipt.validator_pubkey_hex, PUBKEY_BYTES);
  const signature = hexToBytes(receipt.signature_hex, SIGNATURE_BYTES);
  const message = hexToBytes(receipt.message_hex, MESSAGE_BYTES);
  if (!publicKey || !signature || !message) return null;
  return { publicKey, signature, message };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** Check the signed message fields before a wallet submits the transition. */
export function receiptMatchesBinding(receipt: SignedReceiptDto, binding: ReceiptBinding): boolean {
  const decoded = decodeSignedReceipt(receipt);
  if (!decoded) return false;
  const { message } = decoded;
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  return (
    equalBytes(message.subarray(0, 28), RECEIPT_DOMAIN) &&
    message[28] === binding.purpose &&
    view.getUint16(29, true) === binding.projectionVersion &&
    equalBytes(message.subarray(31, 63), binding.wallet) &&
    equalBytes(message.subarray(63, 95), binding.commitment)
  );
}

/**
 * Build the Ed25519 verification instruction for a mint or rebaseline receipt.
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
