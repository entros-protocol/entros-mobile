// On-chain MigrationRecord reads.
//
// When an identity migrates to a new wallet, entros-anchor writes a record at
// PDA seeds ["migration", new wallet] that names the wallet it came from. The
// app reads it to find a baseline the phone stored under that earlier wallet.
//
// Fixed-offset reads, like ./identity.ts. These offsets must match
// `MigrationRecord` in protocol-core/programs/entros-anchor/src/state.rs.

import { type Connection, PublicKey } from "@solana/web3.js";

import { config } from "@/config";
import { devWarn } from "@/lib/log";

import { findMigrationPda } from "./pdas";

const DISCRIMINATOR = [16, 36, 116, 243, 192, 61, 40, 1] as const;
const OFFSET = {
  MIGRATED_AT: 8, // i64 LE
  MIGRATED_SLOT: 16, // u64 LE
  BUMP: 24, // u8
  PREVIOUS_WALLET: 25, // 32 bytes
} as const;
/** Bytes of a record through `previous_wallet`. A shorter account names no wallet. */
const RECORD_SIZE = 57;

export interface MigrationRecord {
  /** Cluster time of the most recent migration to this wallet, in seconds. */
  migratedAt: number;
  migratedSlot: bigint;
  /** The wallet that held the identity before that migration, in base58. */
  previousWallet: string;
}

/**
 * Reads the migration record of `walletPubkey`. Null when the account is
 * absent, another program owns it, or its data is not a full record. A failed
 * RPC read returns null too, unless `failClosed` is set, which makes it throw.
 */
export async function fetchMigrationRecord(
  walletPubkey: PublicKey,
  connection: Connection,
  failClosed = false,
): Promise<MigrationRecord | null> {
  const programId = config.programs.entrosAnchor;
  if (!programId) return null;

  let accountInfo;
  try {
    accountInfo = await connection.getAccountInfo(
      findMigrationPda(walletPubkey, programId),
      "confirmed",
    );
  } catch (err) {
    if (failClosed) throw err;
    devWarn("[Entros] getAccountInfo(migration) failed", err);
    return null;
  }
  if (!accountInfo) return null;
  // Anyone can fund the address, and only the program can write a record.
  if (!accountInfo.owner.equals(programId)) return null;

  const data = accountInfo.data;
  if (data.length < RECORD_SIZE) return null;
  if (DISCRIMINATOR.some((byte, index) => data[index] !== byte)) {
    devWarn("[Entros] migration account has an unexpected discriminator");
    return null;
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    migratedAt: Number(view.getBigInt64(OFFSET.MIGRATED_AT, true)),
    migratedSlot: view.getBigUint64(OFFSET.MIGRATED_SLOT, true),
    previousWallet: new PublicKey(
      data.subarray(OFFSET.PREVIOUS_WALLET, OFFSET.PREVIOUS_WALLET + 32),
    ).toBase58(),
  };
}
