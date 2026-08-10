// Receipt decoder + Ed25519 instruction builder unit tests.
//
// We deliberately don't parity-test against pulse-sdk's
// `Ed25519Program.createInstructionWithPublicKey` output — both call sites
// resolve to the same `@solana/web3.js@1.98.4` API, so byte equivalence is
// guaranteed by web3.js itself. What we DO test is the port surface:
//   1. Hex parsing rejects malformed inputs (length, non-hex, missing fields)
//   2. Hex parsing accepts the valid wire format with and without `0x` prefix
//   3. Successful decode produces an Ed25519 verify ix with the right
//      programId and the receipt message embedded in the ix data
// These are the failure modes a port refactor (substr→slice, regex tweaks,
// length sentinel changes) could introduce without surfacing at the
// integration level.

import { Ed25519Program } from "@solana/web3.js";

import {
  buildEd25519ReceiptIx,
  decodeSignedReceipt,
  receiptMatchesBinding,
  requireEd25519ReceiptIx,
  type SignedReceiptDto,
} from "../receipt";

/** Build a deterministic 32-byte hex string from a single seed byte: 0xAA →
 *  "aaaaaaaa…aa". Using one repeating byte keeps the fixture compact and
 *  trivially auditable while still exercising the full hex parser. */
const repeatHex = (byte: number, lenBytes: number): string =>
  byte.toString(16).padStart(2, "0").repeat(lenBytes);

const canonicalMessage = (): string => {
  const message = Buffer.alloc(103);
  Buffer.from("entros-validator-receipt-v2\0", "ascii").copy(message, 0);
  message[28] = 2;
  message.writeUInt16LE(1, 29);
  Buffer.from(repeatHex(0x11, 32), "hex").copy(message, 31);
  Buffer.from(repeatHex(0x22, 32), "hex").copy(message, 63);
  message.writeBigInt64LE(1_786_310_400n, 95);
  return message.toString("hex");
};

/** Synthetic but well-formed receipt. We only test the SDK side — actual
 *  Ed25519 signature validity is the validator's job and the on-chain
 *  Ed25519Program's domain. */
const VALID_RECEIPT: SignedReceiptDto = {
  validator_pubkey_hex: repeatHex(0xaa, 32),
  message_hex: canonicalMessage(),
  signature_hex: repeatHex(0xcc, 64),
};

describe("decodeSignedReceipt", () => {
  test("decodes a valid receipt to (32B pubkey, 64B sig, 103B message)", () => {
    const decoded = decodeSignedReceipt(VALID_RECEIPT);
    expect(decoded).not.toBeNull();
    expect(decoded?.publicKey.length).toBe(32);
    expect(decoded?.signature.length).toBe(64);
    expect(decoded?.message.length).toBe(103);
    expect(decoded?.publicKey[0]).toBe(0xaa);
    expect(Buffer.from(decoded!.message.subarray(0, 28)).toString("ascii")).toBe(
      "entros-validator-receipt-v2\0",
    );
    expect(decoded?.message[28]).toBe(2);
    expect(
      new DataView(
        decoded!.message.buffer,
        decoded!.message.byteOffset,
        decoded!.message.byteLength,
      ).getUint16(29, true),
    ).toBe(1);
    expect(decoded?.signature[0]).toBe(0xcc);
  });

  test("permits a leading 0x prefix on any field", () => {
    const decoded = decodeSignedReceipt({
      validator_pubkey_hex: "0x" + VALID_RECEIPT.validator_pubkey_hex,
      message_hex: "0X" + VALID_RECEIPT.message_hex,
      signature_hex: VALID_RECEIPT.signature_hex,
    });
    expect(decoded).not.toBeNull();
    expect(decoded?.publicKey[0]).toBe(0xaa);
  });

  test("returns null when pubkey hex is the wrong length", () => {
    expect(
      decodeSignedReceipt({ ...VALID_RECEIPT, validator_pubkey_hex: repeatHex(0xaa, 31) }),
    ).toBeNull();
  });

  test("returns null when signature hex is the wrong length", () => {
    expect(
      decodeSignedReceipt({ ...VALID_RECEIPT, signature_hex: repeatHex(0xcc, 65) }),
    ).toBeNull();
  });

  test("returns null when message hex is the wrong length", () => {
    expect(decodeSignedReceipt({ ...VALID_RECEIPT, message_hex: repeatHex(0xbb, 102) })).toBeNull();
  });

  test("returns null on non-hex characters", () => {
    expect(
      decodeSignedReceipt({ ...VALID_RECEIPT, validator_pubkey_hex: "g".repeat(64) }),
    ).toBeNull();
  });

  test("returns null on odd-length input (rejected by length check, not by parser)", () => {
    expect(
      decodeSignedReceipt({ ...VALID_RECEIPT, validator_pubkey_hex: "a".repeat(63) }),
    ).toBeNull();
  });
});

describe("buildEd25519ReceiptIx", () => {
  test("returns an Ed25519Program instruction for a valid receipt", () => {
    const ix = buildEd25519ReceiptIx(VALID_RECEIPT);
    expect(ix).not.toBeNull();
    expect(ix?.programId.equals(Ed25519Program.programId)).toBe(true);
    expect(ix?.keys).toEqual([]);
    // The ix data packs (header + offsets + pubkey + signature + message). The
    // The message is the largest contiguous slice and trivial to find. We
    // assert it survives intact rather than reproducing the full layout here.
    const data = Buffer.from(ix!.data);
    const messageBytes = Buffer.from(canonicalMessage(), "hex");
    expect(data.includes(messageBytes)).toBe(true);
  });

  test("returns null when the receipt fails to decode", () => {
    expect(buildEd25519ReceiptIx({ ...VALID_RECEIPT, signature_hex: "" })).toBeNull();
  });
});

describe("requireEd25519ReceiptIx", () => {
  test("rejects a missing first-verification receipt", () => {
    expect(() => requireEd25519ReceiptIx(undefined)).toThrow(
      "First verification requires a validator-signed receipt.",
    );
  });

  test("rejects a malformed first-verification receipt", () => {
    expect(() => requireEd25519ReceiptIx({ ...VALID_RECEIPT, signature_hex: "" })).toThrow(
      "The validator-signed receipt is malformed.",
    );
  });

  test("returns an Ed25519 instruction for a valid receipt", () => {
    const ix = requireEd25519ReceiptIx(VALID_RECEIPT);
    expect(ix.programId.equals(Ed25519Program.programId)).toBe(true);
  });
});

describe("receipt transition binding", () => {
  test("accepts only the expected purpose, version, wallet, and commitment", () => {
    const decoded = decodeSignedReceipt(VALID_RECEIPT)!;
    const binding = {
      purpose: 2 as const,
      projectionVersion: 1,
      wallet: decoded.message.subarray(31, 63),
      commitment: decoded.message.subarray(63, 95),
    };

    expect(receiptMatchesBinding(VALID_RECEIPT, binding)).toBe(true);
    expect(receiptMatchesBinding(VALID_RECEIPT, { ...binding, purpose: 3 })).toBe(false);
  });
});
