// Stage 7 instruction builders. Each function returns a single
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
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  findChallengePda,
  findIdentityPda,
  findMintAuthorityPda,
  findMintPda,
  findProtocolConfigPda,
  findTreasuryPda,
  findVerificationPda,
} from "./pdas";

/** Token-2022 program — the runtime our non-transferable mint targets. */
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** Anchor 0.32 program.methods is structurally typed `Record<string, ...>`
 *  at runtime; we don't vendor the IDL-generated TypeScript types from
 *  protocol-core. The intersection here loosens `methods` to a string-
 *  keyed record so the call sites don't need per-method casts. Pulse-sdk
 *  uses the same pattern (`const program: any = new Program(...)`); ours
 *  retains `Program<Idl>` constraints elsewhere on the instance. */
export type AnchorProgram = Program<Idl> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  methods: Record<string, any>;
};

export interface BuildContext {
  /** entros_anchor program — owns IdentityState, mint_anchor, update_anchor,
   *  reset_identity_state. */
  anchorProgram: AnchorProgram;
  /** entros_verifier program — owns Challenge, VerificationResult,
   *  create_challenge, verify_proof. */
  verifierProgram: AnchorProgram;
  /** entros_registry program ID — read-only PDAs (protocol_config + treasury). */
  registryProgramId: PublicKey;
  /** Verifying user's wallet pubkey. */
  walletPubkey: PublicKey;
}

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
  const ata = getAssociatedTokenAddressSync(
    mintPda,
    ctx.walletPubkey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  // The Instructions sysvar lets `verify_mint_receipt` inspect the preceding
  // Ed25519 verification. The program requires that receipt for every mint.
  return ctx.anchorProgram.methods
    .mintAnchor(Array.from(initialCommitment))
    .accounts({
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
    })
    .instruction();
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
  if (projectionVersion >= 1) {
    resetBuilder = resetBuilder.remainingAccounts([
      {
        pubkey: SYSVAR_INSTRUCTIONS_PUBKEY,
        isSigner: false,
        isWritable: false,
      },
    ]);
  }
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

  return ctx.anchorProgram.methods
    .rebaselineAnchor(Array.from(newCommitment), projectionVersion)
    .accounts({
      authority: ctx.walletPubkey,
      identityState: identityPda,
      protocolConfig: protocolConfigPda,
      treasury: treasuryPda,
      instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/** Per-instruction CU usage measured against devnet (entros-verifier
 *  Groth16 verify is the heaviest at ~180K CU). 250K leaves headroom over
 *  the ~205K typical re-verify total without burning the user's fee. */
export const COMPUTE_UNITS_REVERIFY = 250_000;
export const COMPUTE_UNITS_RESET = 150_000;
export const COMPUTE_UNITS_REBASELINE = 150_000;

export const buildComputeBudgetIx = (units: number): TransactionInstruction =>
  ComputeBudgetProgram.setComputeUnitLimit({ units });
