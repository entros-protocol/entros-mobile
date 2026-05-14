// Stage 8 — on-chain ProtocolConfig reads.
//
// The entros_registry program owns the ProtocolConfig PDA which holds the
// global verification_fee (lamports per verification) and other
// admin-tunable parameters. /verify/intro renders the live fee so the user
// sees what they'll be charged before tapping Begin, instead of a hardcoded
// estimate that drifts when the protocol admin updates the fee.
//
// Like fetchIdentityState, this decodes against the bundled registry IDL
// for zero IDL-fetch RPC overhead. The field returned is in **lamports**;
// the caller divides by 1e9 to render SOL.

import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { type Connection } from "@solana/web3.js";

import { config } from "@/config";
import { devWarn } from "@/lib/log";

import { entrosRegistryIdl } from "./idl";
import { findProtocolConfigPda } from "./pdas";

/** Subset of the on-chain `ProtocolConfig` struct we render in mobile.
 *  Other fields (admin, min_stake, max_trust_score, base_trust_increment,
 *  challenge_expiry, bump) are read by the protocol but not surfaced in
 *  the user-facing UI here. Add them if a future screen needs them. */
export interface ProtocolConfigSnapshot {
  /** Lamports per verification. Divide by 1e9 to render in SOL. */
  verificationFeeLamports: number;
  /** Seconds until a server-issued challenge nonce expires on-chain. */
  challengeExpirySeconds: number;
}

/** Reads the ProtocolConfig PDA from the entros_registry program. Returns
 *  null if the program ID env var is unset, the PDA hasn't been
 *  initialized, or the decode fails — callers fall back to a sensible
 *  hardcoded approximation. Never throws. */
export async function fetchProtocolConfig(
  connection: Connection,
): Promise<ProtocolConfigSnapshot | null> {
  const programId = config.programs.entrosRegistry;
  if (!programId) return null;

  const pda = findProtocolConfigPda(programId);

  const accountInfo = await connection.getAccountInfo(pda, "confirmed").catch((err) => {
    devWarn("[Entros] getAccountInfo(protocolConfig) failed", err);
    return null;
  });
  if (!accountInfo) return null;

  let decoded: Record<string, unknown>;
  try {
    const coder = new BorshAccountsCoder(entrosRegistryIdl as unknown as Idl);
    // Anchor 0.30+ IDL spec: account names are PascalCase and field names
    // stay snake_case in the decoded object. Using camelCase here silently
    // throws "Account not found" which the catch below swallows as null,
    // falling back to hardcoded fee values rather than the live config.
    decoded = coder.decode("ProtocolConfig", accountInfo.data) as Record<string, unknown>;
  } catch (err) {
    devWarn("[Entros] ProtocolConfig decode failed", err);
    return null;
  }

  return {
    verificationFeeLamports: Number(decoded["verification_fee"]),
    challengeExpirySeconds: Number(decoded["challenge_expiry"]),
  };
}

/** Format lamports as a SOL string with 3-decimal precision: 5_000_000 →
 *  "≈ 0.005 SOL". Matches the existing /verify/intro label so swapping
 *  hardcoded → live is a drop-in render replacement. */
export function formatLamportsAsSol(lamports: number): string {
  return `≈ ${(lamports / 1e9).toFixed(3)} SOL`;
}
