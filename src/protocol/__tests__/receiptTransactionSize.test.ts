// The receipt-bound transactions with a 136-byte receipt must fit one packet.
// Each case runs the real submit path, captures the transaction handed to the
// wallet, and serializes it the way the wallet sends it.

import { Keypair, type Transaction } from "@solana/web3.js";

import type { SignedReceiptDto } from "../receipt";
import { submitRebaseline, submitReset, submitVerify } from "../submit";

/** The largest serialized transaction the network accepts, in bytes. */
const PACKET_DATA_SIZE = 1232;

const mockCaptured: Transaction[] = [];

jest.mock("@/wallet/mwa", () => ({
  signAndSendTransaction: jest.fn(async (_authToken: string, transaction: Transaction) => {
    mockCaptured.push(transaction);
    return { signature: "synthetic-signature", authToken: "synthetic-token" };
  }),
}));

jest.mock("@/config", () => {
  const { PublicKey: Key } = jest.requireActual("@solana/web3.js");
  const anchor = jest.requireActual("../idl/entros_anchor.json");
  const verifier = jest.requireActual("../idl/entros_verifier.json");
  const genesis = new Key(new Uint8Array(32).fill(71)).toBase58();
  return {
    config: {
      programs: {
        entrosAnchor: new Key(anchor.address),
        entrosVerifier: new Key(verifier.address),
        entrosRegistry: new Key("6VBs3zr9KrfFPGd6j7aGBPQWwZa5tajVfA7HN6MMV9VW"),
      },
      proofManifest: {
        generation: "request-bound-v1",
        deploymentDomain: "11".repeat(32),
        genesisHash: genesis,
        consumerProgram: anchor.address,
        verifierProgram: verifier.address,
        zkey: { uri: "file:///test/key.zkey", sha256: "cd".repeat(32) },
      },
    },
    getConnection: () => ({
      rpcEndpoint: "http://127.0.0.1:8899",
      commitment: "confirmed",
      getGenesisHash: async () => genesis,
      getLatestBlockhash: async () => ({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 1,
      }),
      confirmTransaction: async () => ({ value: { err: null } }),
    }),
  };
});

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(23)).publicKey;
const commitment = new Uint8Array(32).fill(7);
const base = {
  walletAddress: wallet.toBase58(),
  authToken: "synthetic",
  walletKind: "phantom" as const,
};

function v3Receipt(purpose: 1 | 2 | 3): SignedReceiptDto {
  const message = Buffer.alloc(136);
  Buffer.from("entros-validator-receipt-v3\0", "ascii").copy(message, 0);
  message[28] = purpose;
  message.writeUInt16LE(1, 29);
  wallet.toBuffer().copy(message, 31);
  Buffer.from(commitment).copy(message, 63);
  message.writeBigInt64LE(1_790_000_000n, 95);
  Buffer.alloc(32, 9).copy(message, 103);
  message[135] = 2;
  return {
    validator_pubkey_hex: "8c".repeat(32),
    signature_hex: "ab".repeat(64),
    message_hex: message.toString("hex"),
  };
}

async function serializedSize(submit: () => Promise<unknown>): Promise<number> {
  mockCaptured.length = 0;
  await submit();
  expect(mockCaptured).toHaveLength(1);
  const transaction = mockCaptured[0]!;
  // The Ed25519 instruction carries 16 header bytes, the key, the signature and the message.
  const receiptInstruction = transaction.instructions.find(
    (instruction) => instruction.data.length === 16 + 32 + 64 + 136,
  );
  expect(receiptInstruction).toBeDefined();
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
}

describe("receipt-bound transactions with a version 3 receipt", () => {
  const cases: [string, () => Promise<unknown>][] = [
    [
      "first mint",
      () => submitVerify({ ...base, commitment, isFirstVerify: true, signedReceipt: v3Receipt(1) }),
    ],
    [
      "rebaseline",
      () =>
        submitRebaseline({
          ...base,
          commitment,
          projectionVersion: 1,
          signedReceipt: v3Receipt(2),
        }),
    ],
    [
      "reset",
      () => submitReset({ ...base, commitment, projectionVersion: 1, signedReceipt: v3Receipt(3) }),
    ],
  ];

  test.each(cases)("the %s fits one packet", async (_name, submit) => {
    expect(await serializedSize(submit)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
  });
});
