// Deterministic PDA derivations for the three on-chain programs. Seed
// strings are the protocol-frozen values; changing any one would
// invalidate every existing on-chain account.
//
// Verified against pulse-sdk/src/submit/wallet.ts which uses the
// identical seeds for the web flow. Same web/mobile derivation = same
// PDA = same on-chain account, regardless of which client submits.

import { PublicKey } from "@solana/web3.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** identity_state PDA — owns the user's `IdentityState` account holding
 *  trust_score, verification_count, current_commitment, mint, etc. */
export const findIdentityPda = (wallet: PublicKey, anchorProgramId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([enc("identity"), wallet.toBuffer()], anchorProgramId)[0];

/** mint PDA — the wallet-bound non-transferable Token-2022 mint. */
export const findMintPda = (wallet: PublicKey, anchorProgramId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([enc("mint"), wallet.toBuffer()], anchorProgramId)[0];

/** mint_authority PDA — global authority for all entros anchor mints. */
export const findMintAuthorityPda = (anchorProgramId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([enc("mint_authority")], anchorProgramId)[0];

/** challenge PDA — short-lived (≤5 min on-chain TTL) per-nonce challenge
 *  account created by `create_challenge` and consumed by `verify_proof`. */
export const findChallengePda = (
  wallet: PublicKey,
  nonce: Uint8Array,
  verifierProgramId: PublicKey,
): PublicKey =>
  PublicKey.findProgramAddressSync(
    [enc("challenge"), wallet.toBuffer(), nonce],
    verifierProgramId,
  )[0];

/** verification PDA — `VerificationResult` written by `verify_proof`,
 *  consumed by `update_anchor` (binds proof success to commitment update). */
export const findVerificationPda = (
  wallet: PublicKey,
  nonce: Uint8Array,
  verifierProgramId: PublicKey,
): PublicKey =>
  PublicKey.findProgramAddressSync(
    [enc("verification"), wallet.toBuffer(), nonce],
    verifierProgramId,
  )[0];

/** protocol_config PDA — global protocol parameters (verification_fee,
 *  treasury authority, etc.). Read-only from this client. */
export const findProtocolConfigPda = (registryProgramId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([enc("protocol_config")], registryProgramId)[0];

/** protocol_treasury PDA — fee recipient for mint_anchor / update_anchor /
 *  reset_identity_state. */
export const findTreasuryPda = (registryProgramId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([enc("protocol_treasury")], registryProgramId)[0];
