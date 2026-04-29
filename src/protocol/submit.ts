// Stage 7 high-level submission orchestration. Wraps Anchor instruction
// builders + MWA's signAndSendTransaction into two coherent flows:
//
//   - submitVerify({ commitment, isFirstVerify, proof?, nonce? })
//       First verify  → mintAnchor (single ix)
//       Re-verify     → ComputeBudget + createChallenge + verifyProof + updateAnchor (4 ix in one tx)
//
//   - submitReset({ commitment }) → ComputeBudget + resetIdentityState (2 ix)
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
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

import { config, getConnection } from "@/config";
import { devWarn } from "@/lib/log";
import type { SolanaProof } from "@/proof";
import type { WalletKind } from "@/state/types";
import * as mwa from "@/wallet/mwa";

import { makeAnchorAdapter } from "./anchorAdapter";
import { entrosAnchorIdl, entrosVerifierIdl } from "./idl";
import {
  buildComputeBudgetIx,
  buildCreateChallengeIx,
  buildMintAnchorIx,
  buildResetIdentityStateIx,
  buildUpdateAnchorIx,
  buildVerifyProofIx,
  BuildContext,
  AnchorProgram,
  COMPUTE_UNITS_RESET,
  COMPUTE_UNITS_REVERIFY,
} from "./instructions";
import { buildEd25519ReceiptIx, type SignedReceiptDto } from "./receipt";

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
}

const buildContext = (walletAddress: string): BuildContext => {
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

  const anchorProgram = new Program(entrosAnchorIdl as Idl, provider) as AnchorProgram;
  const verifierProgram = new Program(entrosVerifierIdl as Idl, provider) as AnchorProgram;

  // entros_registry exposes only protocol_config + treasury PDAs — derived
  // from the program ID alone, no IDL needed for instruction building.
  // Stage 8 will import the registry IDL for BorshAccountsCoder reads.
  return {
    anchorProgram,
    verifierProgram,
    registryProgramId,
    walletPubkey: adapter.publicKey,
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
  /** Validator-signed mint receipt (master-list #146 Phase 4). First-verify
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
  const ctx = buildContext(args.walletAddress);
  const connection = getConnection();

  let ixs: TransactionInstruction[];
  if (args.isFirstVerify) {
    // Tx layout:
    //   [0] (optional) Ed25519Program::verify(receipt)
    //   [1] mint_anchor(initial_commitment)
    // Phase 3's on-chain check is log-only, so a missing or undecodeable
    // receipt is fine for now; once Phase 5 enforcement flips, missing
    // receipts hard-fail mint_anchor and this fallback becomes a deliberate
    // "no-receipt" path the program rejects.
    const ed25519Ix = args.signedReceipt ? buildEd25519ReceiptIx(args.signedReceipt) : null;
    const mintIx = await buildMintAnchorIx(ctx, args.commitment);
    if (args.signedReceipt && ed25519Ix) {
      devWarn("[Entros] Bundling validator-signed mint receipt before mint_anchor");
    } else if (args.signedReceipt) {
      devWarn("[Entros] signedReceipt provided but failed to decode; minting without binding");
    } else {
      devWarn(
        "[Entros] No validator receipt available; minting without binding (Phase 3 log-only)",
      );
    }
    ixs = ed25519Ix ? [ed25519Ix, mintIx] : [mintIx];
  } else {
    if (!args.proof || !args.nonce) {
      throw new Error(
        "submitVerify: re-verification requires both `proof` and `nonce`. " +
          "Stage 6's proofBuffer and Stage 4's challengeBuffer must both be populated.",
      );
    }
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

  const tx = await sealTransaction(connection, ctx.walletPubkey, ixs);
  const result = await mwa.signAndSendTransaction(args.authToken, tx, args.walletKind);
  onSigned?.();
  await connection.confirmTransaction(result.signature, "confirmed");
  return { txSignature: result.signature, authToken: result.authToken };
}

/** Reset the on-chain `IdentityState.current_commitment` in place. Used
 *  when the local encrypted baseline is unrecoverable but the on-chain
 *  anchor still exists. The reset rotates the commitment, zeroes
 *  verification_count/trust_score/recent_timestamps, and triggers a
 *  7-day cooldown before the next reset. */
export interface SubmitResetArgs extends SubmitBase {
  commitment: Uint8Array;
}

export async function submitReset(
  args: SubmitResetArgs,
  onSigned?: () => void,
): Promise<SubmitResult> {
  const ctx = buildContext(args.walletAddress);
  const connection = getConnection();

  const resetIx = await buildResetIdentityStateIx(ctx, args.commitment);
  const ixs: TransactionInstruction[] = [buildComputeBudgetIx(COMPUTE_UNITS_RESET), resetIx];

  const tx = await sealTransaction(connection, ctx.walletPubkey, ixs);
  const result = await mwa.signAndSendTransaction(args.authToken, tx, args.walletKind);
  onSigned?.();
  await connection.confirmTransaction(result.signature, "confirmed");
  return { txSignature: result.signature, authToken: result.authToken };
}
