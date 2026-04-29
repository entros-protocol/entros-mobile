// Stage 8 — on-chain IdentityState reads.
//
// Replaces the AppState mock identity with the live PDA contents. Same
// pattern as pulse-sdk/src/identity/anchor.ts:fetchIdentityState — derive
// the identity PDA, getAccountInfo, decode via Anchor's BorshAccountsCoder
// against the bundled IDL.
//
// We use the bundled `entros_anchor.json` IDL (already shipped with the app
// as part of Stage 7) instead of `Program.fetchIdl(programId)` so the
// dashboard read needs zero IDL-fetch RPC round-trips on cold start. IDL
// changes require an entros-mobile rebuild — accepted trade for instant
// reads.

import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { type Connection, PublicKey } from "@solana/web3.js";
import { bytesToHex } from "@noble/ciphers/utils.js";

import { config } from "@/config";
import { devWarn } from "@/lib/log";
import type { IdentityState } from "@/state/types";

import { entrosAnchorIdl } from "./idl";
import { findIdentityPda } from "./pdas";

/** Direct camelCase mirror of the on-chain `IdentityState` struct. Borsh
 *  field order and types match `protocol-core/programs/entros-anchor/src/state.rs`
 *  verbatim — Anchor's BorshAccountsCoder yields these names because the
 *  IDL declares them in snake_case and the coder camelCases on decode. */
export interface OnChainIdentity {
  owner: string;
  creationTimestamp: number;
  lastVerificationTimestamp: number;
  verificationCount: number;
  trustScore: number;
  currentCommitment: Uint8Array;
  mint: string;
  /** Zero for accounts that have never been reset (including freshly
   *  minted accounts and pre-realloc accounts that didn't carry the field). */
  lastResetTimestamp: number;
}

/** Reads the user's `IdentityState` PDA from the entros_anchor program.
 *  Returns null if the account doesn't exist (first-time user pre-mint),
 *  the program ID env var is unset, or the account data fails to decode.
 *  Never throws — caller treats null as "no on-chain identity yet" and
 *  falls back to the cold-state UI. */
export async function fetchIdentityState(
  walletPubkey: PublicKey,
  connection: Connection,
): Promise<OnChainIdentity | null> {
  const programId = config.programs.entrosAnchor;
  if (!programId) return null;

  const identityPda = findIdentityPda(walletPubkey, programId);

  const accountInfo = await connection.getAccountInfo(identityPda, "confirmed").catch((err) => {
    devWarn("[Entros] getAccountInfo(identity) failed", err);
    return null;
  });
  if (!accountInfo) return null;

  let decoded: Record<string, unknown>;
  try {
    const coder = new BorshAccountsCoder(entrosAnchorIdl as unknown as Idl);
    decoded = coder.decode("identityState", accountInfo.data) as Record<string, unknown>;
  } catch (err) {
    devWarn("[Entros] IdentityState decode failed", err);
    return null;
  }

  // Anchor's Borsh coder returns BN for i64/u64, primitive number for u8/u16/u32,
  // PublicKey for `pubkey`, and number[] for byte arrays. Normalise to plain
  // JS shapes here. `Number(bn)` handles BN safely for unix timestamps (i64
  // can't exceed Number.MAX_SAFE_INTEGER until year 275760).
  const lastResetRaw = decoded["lastResetTimestamp"];
  return {
    owner: (decoded["owner"] as PublicKey).toBase58(),
    creationTimestamp: Number(decoded["creationTimestamp"]),
    lastVerificationTimestamp: Number(decoded["lastVerificationTimestamp"]),
    verificationCount: Number(decoded["verificationCount"]),
    trustScore: Number(decoded["trustScore"]),
    currentCommitment: new Uint8Array(decoded["currentCommitment"] as ArrayLike<number>),
    mint: (decoded["mint"] as PublicKey).toBase58(),
    lastResetTimestamp: lastResetRaw == null ? 0 : Number(lastResetRaw),
  };
}

/** Adapter: on-chain shape → AppState IdentityState shape. Returning a fresh
 *  object every call is intentional so reducer reference checks fire and
 *  React re-renders on the next render pass. The `0x`-prefixed hex
 *  commitment matches the mock format and what the existing dashboard
 *  truncates for display. */
export function toAppStateIdentity(onChain: OnChainIdentity): IdentityState {
  return {
    hasAnchor: true,
    trustScore: onChain.trustScore,
    verifications: onChain.verificationCount,
    lastVerifiedAt:
      onChain.lastVerificationTimestamp > 0
        ? new Date(onChain.lastVerificationTimestamp * 1000)
        : null,
    commitment: `0x${bytesToHex(onChain.currentCommitment)}`,
    mint: onChain.mint,
    createdAt: new Date(onChain.creationTimestamp * 1000),
  };
}
