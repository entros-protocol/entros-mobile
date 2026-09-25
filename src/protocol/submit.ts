// Wraps Anchor instruction builders and MWA signing into two flows:
//
//   - submitVerify({ commitment, isFirstVerify, proof?, nonce? })
//       First verify  → mintAnchor (single ix)
//       Re-verify     → ComputeBudget + createChallenge + verifyProof + updateAnchor (4 ix in one tx)
//
//   - submitReset({ commitment }) uses a receipt before versioned resets.
//
// PRIVACY:
// - The commitment + proofBytes + publicInputs + nonce all leave the device
//   on this wire. They are public protocol artefacts: the commitment is
//   the on-chain anchor's `current_commitment`, the proof is zero-knowledge,
//   the public inputs (commitment_new/prev/threshold/min_distance) are
//   already-public values, the nonce is server-issued or CSPRNG.
// - The wallet's auth_token rotates per MWA call; persist the new token
//   back to secure storage immediately after success.

import { AnchorProvider, Idl, Program } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import { config, getConnection } from "@/config";
import type { SolanaProof } from "@/proof/types";
import type { WalletKind } from "@/state/types";
import * as mwa from "@/wallet/mwa";

import { makeAnchorAdapter } from "./anchorAdapter";
import { buildBoundProofInstructions, type BoundPrograms } from "./boundInstructions";
import entrosAnchorIdl from "./idl/entros_anchor.json";
import entrosVerifierIdl from "./idl/entros_verifier.json";
import {
  buildComputeBudgetIx,
  buildCreateChallengeIx,
  buildMintAnchorIx,
  buildRebaselineAnchorIx,
  buildResetIdentityStateIx,
  buildUpdateAnchorIx,
  buildVerifyProofIx,
  COMPUTE_UNITS_RESET,
  COMPUTE_UNITS_REBASELINE,
  COMPUTE_UNITS_REVERIFY,
  type AnchorProgram,
  type BuildContext,
  type RuntimeProgram,
  type VerifierProgram,
} from "./instructions";
import { receiptMatchesBinding, requireEd25519ReceiptIx, type SignedReceiptDto } from "./receipt";

/** Result of a successful on-chain submission. */
export interface SubmitResult {
  /** base58-encoded transaction signature. */
  txSignature: string;
  /** Possibly-rotated MWA auth token; caller MUST persist this. */
  authToken: string;
}

/** Common args present in every wallet-driven submission. */
interface SubmitBase {
  walletAddress: string;
  authToken: string;
  walletKind: WalletKind;
  onAuthTokenRotated?: mwa.AuthTokenRotationHandler;
}

const requireProgramMethods = <MethodName extends string>(
  program: Program<Idl>,
  methodNames: readonly MethodName[],
): RuntimeProgram<MethodName> => {
  const methods = (program as unknown as { methods: Record<string, unknown> }).methods;
  for (const methodName of methodNames) {
    if (typeof methods[methodName] !== "function") {
      throw new Error(`The bundled IDL does not define ${methodName}.`);
    }
  }
  return program as unknown as RuntimeProgram<MethodName>;
};

const buildContext = async (
  walletAddress: string,
): Promise<BuildContext & { boundPrograms?: BoundPrograms }> => {
  if (
    config.proofManifest &&
    (await getConnection().getGenesisHash()) !== config.proofManifest.genesisHash
  ) {
    throw new Error("The proof deployment does not match this network.");
  }
  const anchorProgramId = config.programs.entrosAnchor;
  const verifierProgramId = config.programs.entrosVerifier;
  const registryProgramId = config.programs.entrosRegistry;
  if (!anchorProgramId || !verifierProgramId || !registryProgramId) {
    throw new Error(
      "Solana program IDs are not configured. Ensure EXPO_PUBLIC_ENTROS_*_PROGRAM_ID env vars are set in .env.",
    );
  }

  const adapter = makeAnchorAdapter(walletAddress);
  const provider = new AnchorProvider(getConnection(), adapter, {
    commitment: "confirmed",
  });

  const anchorRuntime = new Program(entrosAnchorIdl as Idl, provider);
  const verifierRuntime = new Program(entrosVerifierIdl as Idl, provider);
  const anchorProgram: AnchorProgram = requireProgramMethods(anchorRuntime, [
    "mintAnchor",
    "rebaselineAnchor",
    "resetIdentityState",
    "updateAnchor",
  ] as const);
  const verifierProgram: VerifierProgram = requireProgramMethods(verifierRuntime, [
    "createChallenge",
    "verifyProof",
  ] as const);

  if (
    config.proofManifest &&
    (config.proofManifest.consumerProgram !== anchorProgramId.toBase58() ||
      config.proofManifest.verifierProgram !== verifierProgramId.toBase58())
  )
    throw new Error("The proof manifest does not match the configured programs.");
  const boundPrograms: BoundPrograms | undefined = config.proofManifest
    ? {
        anchor: requireProgramMethods(anchorRuntime, [
          "prepareProofRequest",
          "updateAnchorBound",
          "upgradeIdentityLayout",
        ] as const),
        verifier: requireProgramMethods(verifierRuntime, ["verifyProofBound"] as const),
      }
    : undefined;

  // entros_registry exposes only protocol_config and treasury PDAs, derived
  // from the program ID alone, no IDL needed for instruction building.
  return {
    anchorProgram,
    verifierProgram,
    registryProgramId,
    walletPubkey: adapter.publicKey,
    requestBound: config.proofManifest !== undefined,
    boundPrograms,
  };
};

const sealTransaction = async (
  connection: Connection,
  feePayer: PublicKey,
  ixs: TransactionInstruction[],
): Promise<Transaction> => {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.feePayer = feePayer;
  tx.recentBlockhash = blockhash;
  for (const ix of ixs) tx.add(ix);
  return tx;
};

/** Wait for a tx to confirm AND throw if the chain-side execution errored.
 *  web3.js 1.x's `confirmTransaction` resolves successfully even when the tx
 *  reverted on chain (it only checks signature inclusion); the caller must
 *  inspect `value.err`. Without this surface, on-chain Anchor errors are
 *  silently swallowed and `submitVerify` returns a "successful" txSignature
 *  for a tx that didn't actually mutate state. The thrown message preserves
 *  the JSON `InstructionError` shape so `parseSubmitError` can extract the
 *  Custom code via regex. */
const confirmAndCheck = async (connection: Connection, signature: string): Promise<void> => {
  const confirmation = await connection.confirmTransaction(signature, "confirmed");
  if (confirmation.value.err != null) {
    throw new Error(
      `Transaction failed on chain: ${JSON.stringify(confirmation.value.err)} (sig=${signature})`,
    );
  }
};

export async function submitProofIdentityUpgrade(args: SubmitBase): Promise<SubmitResult> {
  const ctx = await buildContext(args.walletAddress);
  if (!ctx.boundPrograms) throw new Error("The bound proof deployment is not configured.");
  const identity = PublicKey.findProgramAddressSync(
    [Buffer.from("identity"), ctx.walletPubkey.toBytes()],
    ctx.anchorProgram.programId,
  )[0];
  const instruction = await ctx.boundPrograms.anchor.methods
    .upgradeIdentityLayout()
    .accounts({
      authority: ctx.walletPubkey,
      identityState: identity,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  const connection = getConnection();
  const transaction = await sealTransaction(connection, ctx.walletPubkey, [instruction]);
  const result = await mwa.signAndSendTransaction(
    args.authToken,
    transaction,
    args.walletAddress,
    args.walletKind,
    args.onAuthTokenRotated,
  );
  await confirmAndCheck(connection, result.signature);
  return { txSignature: result.signature, authToken: result.authToken };
}

/** First-verify or re-verify on-chain submission. Discriminator is
 *  `isFirstVerify`: when true, only `commitment` is required and we mint
 *  a fresh anchor; when false, all four (commitment, proof, nonce) are
 *  required for the verify+update batch.
 *
 *  `onSigned` fires once, after the wallet returns the signature but
 *  before `confirmTransaction` resolves. Lets the caller transition the
 *  UI from "signing" → "submitting" without splitting submitVerify into
 *  two functions. */
export interface SubmitVerifyArgs extends SubmitBase {
  commitment: Uint8Array;
  isFirstVerify: boolean;
  proof?: SolanaProof;
  nonce?: number[];
  /** Validator-signed mint receipt. First-verify
   *  bundles it as an `Ed25519Program::verify` instruction immediately
   *  before `mint_anchor` so the on-chain program can verify the validator
   *  endorsed the commitment via the Instructions sysvar. Re-verify ignores
   *  this — `update_anchor` enforces binding via the VerificationResult PDA. */
  signedReceipt?: SignedReceiptDto;
}

export async function submitVerify(
  args: SubmitVerifyArgs,
  onSigned?: () => void,
): Promise<SubmitResult> {
  const ctx = await buildContext(args.walletAddress);
  const firstReceiptIxs = args.isFirstVerify ? [requireEd25519ReceiptIx(args.signedReceipt)] : [];
  const connection = getConnection();

  let ixs: TransactionInstruction[];
  if (args.isFirstVerify) {
    // Tx layout:
    //   [0] Ed25519Program::verify(receipt)
    //   [1] mint_anchor(initial_commitment)
    const mintIx = await buildMintAnchorIx(ctx, args.commitment);
    ixs = [...firstReceiptIxs, mintIx];
  } else {
    if (!args.proof || !args.nonce) {
      throw new Error("submitVerify: re-verification requires both `proof` and `nonce`.");
    }
    if (config.proofManifest) {
      if (!ctx.boundPrograms) throw new Error("The bound proof programs are unavailable.");
      ixs = [
        buildComputeBudgetIx(COMPUTE_UNITS_REVERIFY),
        ...(await buildBoundProofInstructions(
          ctx,
          ctx.boundPrograms,
          config.proofManifest,
          args.proof,
          args.commitment,
          args.nonce,
        )),
      ];
    } else {
      if (args.proof.preparedRequest)
        throw new Error("A bound proof requires its configured deployment.");
      const [createChallengeIx, verifyProofIx, updateAnchorIx] = await Promise.all([
        buildCreateChallengeIx(ctx, args.nonce),
        buildVerifyProofIx(ctx, args.proof.proofBytes, args.proof.publicInputs, args.nonce),
        buildUpdateAnchorIx(ctx, args.commitment, args.nonce),
      ]);
      ixs = [
        buildComputeBudgetIx(COMPUTE_UNITS_REVERIFY),
        createChallengeIx,
        verifyProofIx,
        updateAnchorIx,
      ];
    }
  }

  const tx = await sealTransaction(connection, ctx.walletPubkey, ixs);
  const result = await mwa.signAndSendTransaction(
    args.authToken,
    tx,
    args.walletAddress,
    args.walletKind,
    args.onAuthTokenRotated,
  );
  onSigned?.();
  await confirmAndCheck(connection, result.signature);
  return { txSignature: result.signature, authToken: result.authToken };
}

/** Reset the on-chain `IdentityState.current_commitment` in place. Used
 *  when the local encrypted baseline is unrecoverable but the on-chain
 *  anchor still exists. The reset rotates the commitment, zeroes
 *  verification_count/trust_score/recent_timestamps, and triggers a
 *  7-day cooldown before the next reset. */
export interface SubmitResetArgs extends SubmitBase {
  commitment: Uint8Array;
  projectionVersion: number;
  signedReceipt?: SignedReceiptDto;
}

export async function submitReset(
  args: SubmitResetArgs,
  onSigned?: () => void,
): Promise<SubmitResult> {
  const ctx = await buildContext(args.walletAddress);
  const connection = getConnection();

  const receiptIxs: TransactionInstruction[] = [];
  if (args.projectionVersion >= 1) {
    if (
      !args.signedReceipt ||
      !receiptMatchesBinding(args.signedReceipt, {
        purpose: 3,
        projectionVersion: args.projectionVersion,
        wallet: ctx.walletPubkey.toBytes(),
        commitment: args.commitment,
      })
    ) {
      throw new Error("Baseline reset requires a matching validator-signed receipt.");
    }
    receiptIxs.push(requireEd25519ReceiptIx(args.signedReceipt));
  }

  const resetIx = await buildResetIdentityStateIx(ctx, args.commitment, args.projectionVersion);
  const ixs: TransactionInstruction[] = [
    buildComputeBudgetIx(COMPUTE_UNITS_RESET),
    ...receiptIxs,
    resetIx,
  ];

  const tx = await sealTransaction(connection, ctx.walletPubkey, ixs);
  const result = await mwa.signAndSendTransaction(
    args.authToken,
    tx,
    args.walletAddress,
    args.walletKind,
    args.onAuthTokenRotated,
  );
  onSigned?.();
  await confirmAndCheck(connection, result.signature);
  return { txSignature: result.signature, authToken: result.authToken };
}

export interface SubmitRebaselineArgs extends SubmitBase {
  commitment: Uint8Array;
  projectionVersion: number;
  signedReceipt: SignedReceiptDto;
}

/** Submit one authenticated projection migration transaction. */
export async function submitRebaseline(
  args: SubmitRebaselineArgs,
  onSigned?: () => void,
): Promise<SubmitResult> {
  const ctx = await buildContext(args.walletAddress);
  const connection = getConnection();
  if (
    !receiptMatchesBinding(args.signedReceipt, {
      purpose: 2,
      projectionVersion: args.projectionVersion,
      wallet: ctx.walletPubkey.toBytes(),
      commitment: args.commitment,
    })
  ) {
    throw new Error("Projection migration requires a matching validator-signed receipt.");
  }
  const receiptIx = requireEd25519ReceiptIx(args.signedReceipt);
  const rebaselineIx = await buildRebaselineAnchorIx(ctx, args.commitment, args.projectionVersion);
  const ixs = [buildComputeBudgetIx(COMPUTE_UNITS_REBASELINE), receiptIx, rebaselineIx];

  const tx = await sealTransaction(connection, ctx.walletPubkey, ixs);
  const result = await mwa.signAndSendTransaction(
    args.authToken,
    tx,
    args.walletAddress,
    args.walletKind,
    args.onAuthTokenRotated,
  );
  onSigned?.();
  await confirmAndCheck(connection, result.signature);
  return { txSignature: result.signature, authToken: result.authToken };
}
