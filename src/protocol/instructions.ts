// Each instruction builder returns a single
// `TransactionInstruction` so the caller in submit.ts can compose them
// into the right batch (mint = single, re-verify = three, reset = single).
//
// Mirrors pulse-sdk/src/submit/wallet.ts pattern: build via Anchor SDK's
// `program.methods.foo(...).accounts({...}).instruction()` (no signing
// at this layer), let submit.ts handle Transaction assembly + MWA sign+send.
//
// Anchor 0.32 BorshCoder requires Buffer (not Uint8Array) for Vec<u8>
// fields — the Buffer global is provided by `src/polyfills.ts`.

import type { Idl, Program } from "@coral-xyz/anchor";
import {
  type AccountMeta,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  deriveToken2022AssociatedAddress,
} from "./associatedToken";
import {
  findChallengePda,
  findIdentityPda,
  findMintAuthorityPda,
  findMintPda,
  findProtocolConfigPda,
  findTreasuryPda,
  findVerificationPda,
} from "./pdas";
import { proofRequestStateAddress } from "./proofRequest";

interface AnchorInstructionBuilder {
  accounts(accounts: Record<string, PublicKey>): AnchorInstructionBuilder;
  remainingAccounts(accounts: AccountMeta[]): AnchorInstructionBuilder;
  instruction(): Promise<TransactionInstruction>;
}

type AnchorMethod = (...args: unknown[]) => AnchorInstructionBuilder;

/** The bundled IDL supplies method names at runtime but no generated types. */
export type RuntimeProgram<MethodName extends string> = Omit<Program<Idl>, "methods"> & {
  methods: Record<MethodName, AnchorMethod>;
};

export type AnchorProgram = RuntimeProgram<
  "mintAnchor" | "rebaselineAnchor" | "resetIdentityState" | "updateAnchor"
>;
export type VerifierProgram = RuntimeProgram<"createChallenge" | "verifyProof">;

export interface BuildContext {
  /** entros_anchor program — owns IdentityState, mint_anchor, update_anchor,
   *  reset_identity_state. */
  anchorProgram: AnchorProgram;
  /** entros_verifier program — owns Challenge, VerificationResult,
   *  create_challenge, verify_proof. */
  verifierProgram: VerifierProgram;
  /** entros_registry program ID — read-only PDAs (protocol_config + treasury). */
  registryProgramId: PublicKey;
  /** Verifying user's wallet pubkey. */
  walletPubkey: PublicKey;
  requestBound?: boolean;
}

const requestStateMeta = (ctx: BuildContext): AccountMeta => ({
  pubkey: proofRequestStateAddress(ctx.walletPubkey, ctx.anchorProgram.programId),
  isSigner: false,
  isWritable: true,
});

export async function buildMintAnchorIx(
  ctx: BuildContext,
  initialCommitment: Uint8Array,
): Promise<TransactionInstruction> {
  const anchorProgramId = ctx.anchorProgram.programId;
  const identityPda = findIdentityPda(ctx.walletPubkey, anchorProgramId);
  const mintPda = findMintPda(ctx.walletPubkey, anchorProgramId);
  const mintAuthorityPda = findMintAuthorityPda(anchorProgramId);
  const protocolConfigPda = findProtocolConfigPda(ctx.registryProgramId);
  const treasuryPda = findTreasuryPda(ctx.registryProgramId);
  const ata = deriveToken2022AssociatedAddress(mintPda, ctx.walletPubkey);

  // The Instructions sysvar lets `verify_mint_receipt` inspect the preceding
  // Ed25519 verification. The program requires that receipt for every mint.
  let builder = ctx.anchorProgram.methods.mintAnchor(Array.from(initialCommitment)).accounts({
    user: ctx.walletPubkey,
    identityState: identityPda,
    mint: mintPda,
    mintAuthority: mintAuthorityPda,
    tokenAccount: ata,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    protocolConfig: protocolConfigPda,
    treasury: treasuryPda,
    instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
  });
  if (ctx.requestBound) builder = builder.remainingAccounts([requestStateMeta(ctx)]);
  return builder.instruction();
}

export async function buildCreateChallengeIx(
  ctx: BuildContext,
  nonce: number[],
): Promise<TransactionInstruction> {
  const challengePda = findChallengePda(
    ctx.walletPubkey,
    new Uint8Array(nonce),
    ctx.verifierProgram.programId,
  );

  return ctx.verifierProgram.methods
    .createChallenge(nonce)
    .accounts({
      challenger: ctx.walletPubkey,
      challenge: challengePda,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export async function buildVerifyProofIx(
  ctx: BuildContext,
  proofBytes: Uint8Array,
  publicInputs: Uint8Array[],
  nonce: number[],
): Promise<TransactionInstruction> {
  const challengePda = findChallengePda(
    ctx.walletPubkey,
    new Uint8Array(nonce),
    ctx.verifierProgram.programId,
  );
  const verificationPda = findVerificationPda(
    ctx.walletPubkey,
    new Uint8Array(nonce),
    ctx.verifierProgram.programId,
  );

  return ctx.verifierProgram.methods
    .verifyProof(
      Buffer.from(proofBytes),
      publicInputs.map((pi) => Buffer.from(pi)),
      nonce,
    )
    .accounts({
      verifier: ctx.walletPubkey,
      challenge: challengePda,
      verificationResult: verificationPda,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export async function buildUpdateAnchorIx(
  ctx: BuildContext,
  newCommitment: Uint8Array,
  nonce: number[],
): Promise<TransactionInstruction> {
  const anchorProgramId = ctx.anchorProgram.programId;
  const identityPda = findIdentityPda(ctx.walletPubkey, anchorProgramId);
  const verificationPda = findVerificationPda(
    ctx.walletPubkey,
    new Uint8Array(nonce),
    ctx.verifierProgram.programId,
  );
  const protocolConfigPda = findProtocolConfigPda(ctx.registryProgramId);
  const treasuryPda = findTreasuryPda(ctx.registryProgramId);

  return ctx.anchorProgram.methods
    .updateAnchor(Array.from(newCommitment), nonce)
    .accounts({
      authority: ctx.walletPubkey,
      identityState: identityPda,
      verificationResult: verificationPda,
      protocolConfig: protocolConfigPda,
      treasury: treasuryPda,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export async function buildResetIdentityStateIx(
  ctx: BuildContext,
  newCommitment: Uint8Array,
  projectionVersion: number,
): Promise<TransactionInstruction> {
  const anchorProgramId = ctx.anchorProgram.programId;
  const identityPda = findIdentityPda(ctx.walletPubkey, anchorProgramId);
  const protocolConfigPda = findProtocolConfigPda(ctx.registryProgramId);
  const treasuryPda = findTreasuryPda(ctx.registryProgramId);

  let resetBuilder = ctx.anchorProgram.methods
    .resetIdentityState(Array.from(newCommitment), projectionVersion)
    .accounts({
      authority: ctx.walletPubkey,
      identityState: identityPda,
      protocolConfig: protocolConfigPda,
      treasury: treasuryPda,
      systemProgram: SystemProgram.programId,
    });
  const remaining: AccountMeta[] =
    projectionVersion >= 1
      ? [
          {
            pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
            isSigner: false,
            isWritable: false,
          },
        ]
      : [];
  if (ctx.requestBound) remaining.push(requestStateMeta(ctx));
  if (remaining.length > 0) resetBuilder = resetBuilder.remainingAccounts(remaining);
  return resetBuilder.instruction();
}

export async function buildRebaselineAnchorIx(
  ctx: BuildContext,
  newCommitment: Uint8Array,
  projectionVersion: number,
): Promise<TransactionInstruction> {
  const anchorProgramId = ctx.anchorProgram.programId;
  const identityPda = findIdentityPda(ctx.walletPubkey, anchorProgramId);
  const protocolConfigPda = findProtocolConfigPda(ctx.registryProgramId);
  const treasuryPda = findTreasuryPda(ctx.registryProgramId);

  let builder = ctx.anchorProgram.methods
    .rebaselineAnchor(Array.from(newCommitment), projectionVersion)
    .accounts({
      authority: ctx.walletPubkey,
      identityState: identityPda,
      protocolConfig: protocolConfigPda,
      treasury: treasuryPda,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    });
  if (ctx.requestBound) builder = builder.remainingAccounts([requestStateMeta(ctx)]);
  return builder.instruction();
}

/** Per-instruction CU usage measured against devnet (entros-verifier
 *  Groth16 verify is the heaviest at ~180K CU). 250K leaves headroom over
 *  the ~205K typical re-verify total without burning the user's fee. */
export const COMPUTE_UNITS_REVERIFY = 250_000;
export const COMPUTE_UNITS_RESET = 150_000;
export const COMPUTE_UNITS_REBASELINE = 150_000;

export const buildComputeBudgetIx = (units: number): TransactionInstruction =>
  ComputeBudgetProgram.setComputeUnitLimit({ units });
