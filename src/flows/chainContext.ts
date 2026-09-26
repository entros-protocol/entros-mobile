// What the chain says about the next verification: the current projection,
// the wallet's identity, and the receipt the transition needs. Both capture
// paths read it once before validation.

import { PublicKey } from "@solana/web3.js";

import { getConnection } from "@/config";
import { fetchIdentityState, type OnChainIdentity } from "@/protocol/identity";
import { fetchProjectionPolicy } from "@/protocol/protocolConfig";
import type { VerifyIntent } from "@/state/types";

import type { ReceiptPurposeName } from "./verificationPipeline";

export interface ChainContext {
  projectionVersion: number;
  chainIdentity: OnChainIdentity | null;
  /** The identity predates the current projection and must move to it. */
  rebaselineRequired: boolean;
  /** The receipt the transition needs. An update needs none. */
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
  projectionVersion: number,
  hasIdentity: boolean,
  rebaselineRequired: boolean,
): ReceiptPurposeName | undefined {
  if (flowIntent === "reset") return projectionVersion >= 1 ? "reset" : undefined;
  if (flowIntent !== "verify") return undefined;
  if (!hasIdentity) return "mint";
  return rebaselineRequired ? "rebaseline" : undefined;
}

/** Reads the projection policy and the wallet's identity together. */
export async function readChainContext(
  walletAddress: string,
  flowIntent: VerifyIntent,
): Promise<ChainContextResult> {
  let projectionPolicy;
  let chainIdentity;
  try {
    const rpc = getConnection();
    [projectionPolicy, chainIdentity] = await Promise.all([
      fetchProjectionPolicy(rpc),
      fetchIdentityState(new PublicKey(walletAddress), rpc, true),
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
