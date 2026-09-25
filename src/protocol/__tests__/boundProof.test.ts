import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { sha256 } from "@noble/hashes/sha256";
import {
  Keypair,
  PublicKey,
  Connection,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";

import {
  canonicalScalar,
  expectedNativePublicSignals,
  type NativeProofManifest,
} from "@/proof/request";
import type { SolanaProof } from "@/proof/types";

import { buildBoundProofInstructions, type BoundPrograms } from "../boundInstructions";
import {
  type BuildContext,
  type AnchorProgram,
  type VerifierProgram,
  buildMintAnchorIx,
  buildResetIdentityStateIx,
  buildRebaselineAnchorIx,
} from "../instructions";
import {
  NativeIdentityLayoutUpgradeRequired,
  readNativeProofRequest,
  proofRequestStateAddress,
} from "../proofRequest";
import anchorIdl from "../idl/entros_anchor.json";
import verifierIdl from "../idl/entros_verifier.json";

const wallet = Keypair.fromSeed(new Uint8Array(32).fill(61));
const anchor = new PublicKey(anchorIdl.address);
const verifier = new PublicKey(verifierIdl.address);
const nonce = new Uint8Array(32).fill(9);
const manifest: NativeProofManifest = {
  generation: "request-bound-v1",
  deploymentDomain: "11".repeat(32),
  genesisHash: new PublicKey(new Uint8Array(32).fill(71)).toBase58(),
  consumerProgram: anchor.toBase58(),
  verifierProgram: verifier.toBase58(),
  zkey: { uri: "file:///test/key.zkey", sha256: "cd".repeat(32) },
};
const commitments = {
  commitmentNew: "0".repeat(63) + "1",
  commitmentPrevious: "0".repeat(63) + "2",
  threshold: 30,
  minDistance: 3,
};
const discriminator = (name: string) =>
  Buffer.from(sha256(Buffer.from(`account:${name}`)).subarray(0, 8));

function connectionFixture(counter = 3n) {
  const data = Buffer.alloc(593);
  discriminator("IdentityState").copy(data);
  wallet.publicKey.toBuffer().copy(data, 8);
  Buffer.from(commitments.commitmentPrevious, "hex").copy(data, 62);
  PublicKey.findProgramAddressSync([Buffer.from("mint"), wallet.publicKey.toBytes()], anchor)[0]
    .toBuffer()
    .copy(data, 94);
  data[126] = PublicKey.findProgramAddressSync(
    [Buffer.from("identity"), wallet.publicKey.toBytes()],
    anchor,
  )[1];
  data.writeUInt16LE(1, 583);
  const state = Buffer.alloc(50);
  discriminator("ProofRequestState").copy(state);
  state[8] = 1;
  wallet.publicKey.toBuffer().copy(state, 9);
  state.writeBigUInt64LE(counter, 41);
  state[49] = PublicKey.findProgramAddressSync(
    [Buffer.from("proof_request_state"), wallet.publicKey.toBytes()],
    anchor,
  )[1];
  const clock = Buffer.alloc(40);
  clock.writeBigInt64LE(1800000000n, 32);
  const account = (bytes: Buffer) => ({
    data: bytes,
    owner: anchor,
    executable: false,
    lamports: 1000,
  });
  const snapshot = {
    context: { slot: 100 },
    value: [
      account(data),
      account(state),
      { ...account(clock), owner: new PublicKey("Sysvar1111111111111111111111111111111111111") },
    ],
  };
  return {
    state,
    data,
    snapshot,
    getGenesisHash: jest.fn(async () => manifest.genesisHash),
    getMultipleAccountsInfoAndContext: jest.fn(async () => snapshot),
  };
}

function programs() {
  const provider = new AnchorProvider(
    new Connection("http://127.0.0.1:8899"),
    {
      publicKey: wallet.publicKey,
      signTransaction: async (transaction) => transaction,
      signAllTransactions: async (transactions) => transactions,
    },
    {},
  );
  const anchorProgram = new Program(anchorIdl as Idl, provider);
  const verifierProgram = new Program(verifierIdl as Idl, provider);
  const ctx: BuildContext = {
    anchorProgram: anchorProgram as unknown as AnchorProgram,
    verifierProgram: verifierProgram as unknown as VerifierProgram,
    registryProgramId: new PublicKey("6VBs3zr9KrfFPGd6j7aGBPQWwZa5tajVfA7HN6MMV9VW"),
    walletPubkey: wallet.publicKey,
    requestBound: true,
  };
  return {
    ctx,
    bound: { anchor: anchorProgram, verifier: verifierProgram } as unknown as BoundPrograms,
  };
}

describe("native bound proof preparation and transaction", () => {
  it("prepares a pre-funded empty system account without resetting initialized state", async () => {
    const connection = connectionFixture();
    connection.snapshot.value[1]!.owner = SystemProgram.programId;
    connection.snapshot.value[1]!.data = Buffer.alloc(0);
    const request = await readNativeProofRequest(
      connection,
      manifest,
      wallet.publicKey.toBase58(),
      nonce,
      commitments,
    );
    expect(request.action.counter).toBe(0n);
  });

  it.each([543, 551, 583])(
    "requires an authenticated upgrade for the known %s-byte layout",
    async (size) => {
      const connection = connectionFixture();
      connection.snapshot.value[0]!.data = connection.data.subarray(0, size);
      await expect(
        readNativeProofRequest(
          connection,
          manifest,
          wallet.publicKey.toBase58(),
          nonce,
          commitments,
        ),
      ).rejects.toBeInstanceOf(NativeIdentityLayoutUpgradeRequired);
    },
  );

  it.each([207, 592])("rejects an unsupported %s-byte layout", async (size) => {
    const connection = connectionFixture();
    connection.snapshot.value[0]!.data = connection.data.subarray(0, size);
    await expect(
      readNativeProofRequest(connection, manifest, wallet.publicKey.toBase58(), nonce, commitments),
    ).rejects.toThrow("Invalid identity account");
  });

  it("reads identity, counter and clock from one snapshot before proving", async () => {
    const connection = connectionFixture();
    const request = await readNativeProofRequest(
      connection,
      manifest,
      wallet.publicKey.toBase58(),
      nonce,
      commitments,
    );
    expect(request.action.counter).toBe(3n);
    expect(request.action.validUntil).toBe(1800000180n);
    expect(connection.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(1);
    expect(connection.getMultipleAccountsInfoAndContext).toHaveBeenCalledWith(
      expect.arrayContaining([SYSVAR_CLOCK_PUBKEY]),
      "confirmed",
    );
  });

  it.each(["owner", "version", "wallet", "bump", "counter"])(
    "rejects malformed persistent state: %s",
    async (field) => {
      const connection = connectionFixture();
      if (field === "owner") connection.snapshot.value[1]!.owner = SystemProgram.programId;
      if (field === "version") connection.state[8] = 2;
      if (field === "wallet") connection.state[9] = connection.state[9]! ^ 1;
      if (field === "bump") connection.state[49] = connection.state[49]! ^ 1;
      if (field === "counter") connection.state.writeBigUInt64LE((1n << 64n) - 1n, 41);
      await expect(
        readNativeProofRequest(
          connection,
          manifest,
          wallet.publicKey.toBase58(),
          nonce,
          commitments,
        ),
      ).rejects.toThrow();
    },
  );

  it("builds the complete instruction sequence from generated IDLs and rejects substituted context", async () => {
    const request = await readNativeProofRequest(
      connectionFixture(),
      manifest,
      wallet.publicKey.toBase58(),
      nonce,
      commitments,
    );
    const proof: SolanaProof = {
      proofBytes: new Uint8Array(256),
      publicInputs: expectedNativePublicSignals(request).map(canonicalScalar),
      preparedRequest: request,
    };
    const { ctx, bound } = programs();
    const instructions = await buildBoundProofInstructions(
      ctx,
      bound,
      manifest,
      proof,
      Buffer.from(commitments.commitmentNew, "hex"),
      [...nonce],
    );
    expect(instructions).toHaveLength(4);
    expect(instructions[2]!.keys[0]!.pubkey.equals(wallet.publicKey)).toBe(true);
    expect(
      instructions[3]!.keys[2]!.pubkey.equals(proofRequestStateAddress(wallet.publicKey, anchor)),
    ).toBe(true);
    expect(instructions[2]!.data.subarray(-8).readBigUInt64LE()).toBe(request.action.validUntil);
    const changed = {
      ...proof,
      publicInputs: [
        ...proof.publicInputs.slice(0, 5),
        canonicalScalar((BigInt(request.digestLo) + 1n).toString()),
      ],
    };
    await expect(
      buildBoundProofInstructions(
        ctx,
        bound,
        manifest,
        changed,
        Buffer.from(commitments.commitmentNew, "hex"),
        [...nonce],
      ),
    ).rejects.toThrow("public inputs");
    await expect(
      buildBoundProofInstructions(
        ctx,
        bound,
        manifest,
        proof,
        Buffer.from(commitments.commitmentNew, "hex"),
        [...nonce].fill(8),
      ),
    ).rejects.toThrow("nonce");
  });

  it("adds the persistent counter to every available native lifecycle instruction", async () => {
    const { ctx } = programs();
    const commitment = Buffer.from(commitments.commitmentNew, "hex");
    const instructions = await Promise.all([
      buildMintAnchorIx(ctx, commitment),
      buildResetIdentityStateIx(ctx, commitment, 1),
      buildRebaselineAnchorIx(ctx, commitment, 1),
    ]);
    for (const instruction of instructions) {
      const state = instruction.keys.at(-1)!;
      expect(state.pubkey.equals(proofRequestStateAddress(wallet.publicKey, anchor))).toBe(true);
      expect(state.isWritable).toBe(true);
    }
  });
});
