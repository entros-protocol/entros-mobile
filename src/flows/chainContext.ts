// What the chain says about the next verification: the current projection,
// the wallet's identity, and the receipt the transition needs. Both capture
// paths read it once before validation.

import { PublicKey } from "@solana/web3.js";

import { getConnection } from "@/config";
import { fetchIdentityState, type OnChainIdentity } from "@/protocol/identity";
import { fetchMigrationRecord } from "@/protocol/migration";
import { fetchProjectionPolicy } from "@/protocol/protocolConfig";
import type { VerifyIntent } from "@/state/types";

import type { ReceiptPurposeName } from "./verificationPipeline";

export interface ChainContext {
  projectionVersion: number;
  chainIdentity: OnChainIdentity | null;
  /** The wallet the identity last migrated from, when the chain records one. */
  previousWallet: string | null;
  /** The identity predates the current projection and must move to it. */
  rebaselineRequired: boolean;
  /** The receipt the transition needs. */
  receiptPurpose: ReceiptPurposeName | undefined;
}

export type ChainContextResult =
  | { kind: "ok"; chain: ChainContext }
  | { kind: "unreadable"; message: string }
  /** The identity sits on a projection this app cannot prove from. */
  | { kind: "unsupported-identity" };

/** The receipt a transition needs, from the intent and the on-chain identity. */
function receiptPurposeFor(
  flowIntent: VerifyIntent,
  _projectionVersion: number,
  hasIdentity: boolean,
  rebaselineRequired: boolean,
): ReceiptPurposeName | undefined {
  if (flowIntent === "reset") return "reset";
  if (flowIntent !== "verify") return undefined;
  if (!hasIdentity) return "mint";
  return rebaselineRequired ? "rebaseline" : "update";
}

/** Reads the projection policy, the wallet's identity and its migration record together. */
export async function readChainContext(
  walletAddress: string,
  flowIntent: VerifyIntent,
): Promise<ChainContextResult> {
  let projectionPolicy;
  let chainIdentity;
  let migration;
  try {
    const rpc = getConnection();
    const wallet = new PublicKey(walletAddress);
    [projectionPolicy, chainIdentity, migration] = await Promise.all([
      fetchProjectionPolicy(rpc),
      fetchIdentityState(wallet, rpc, true),
      fetchMigrationRecord(wallet, rpc, true),
    ]);
  } catch (error) {
    return {
      kind: "unreadable",
      message: error instanceof Error ? error.message : "Could not read protocol state.",
    };
  }
  const projectionVersion = projectionPolicy.current;
  const rebaselineRequired =
    chainIdentity !== null && chainIdentity.projectionVersion < projectionVersion;
  if (
    chainIdentity &&
    (chainIdentity.projectionVersion > projectionVersion ||
      (chainIdentity.projectionVersion < projectionPolicy.minimumSupported && !rebaselineRequired))
  ) {
    return { kind: "unsupported-identity" };
  }
  return {
    kind: "ok",
    chain: {
      projectionVersion,
      chainIdentity,
      previousWallet: migration?.previousWallet ?? null,
      rebaselineRequired,
      receiptPurpose: receiptPurposeFor(
        flowIntent,
        projectionVersion,
        chainIdentity !== null,
        rebaselineRequired,
      ),
    },
  };
}
