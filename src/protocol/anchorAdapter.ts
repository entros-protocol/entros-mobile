// Adapter that lets the Anchor SDK's `AnchorProvider` accept our MWA
// session. Anchor's `Wallet` interface expects three things —
// `publicKey`, `signTransaction`, `signAllTransactions` — but for our
// flow we only ever use `program.methods.foo(...).instruction()` to BUILD
// instructions (no signing through the provider). Actual signing + send
// happens through `mwa.signAndSendTransaction` after the Transaction is
// assembled.
//
// Design: implement `publicKey` honestly so Anchor's instruction builders
// can derive accounts from it, and implement the two signing methods as
// throwers — if they ever fire, we want a loud failure pointing at the
// architectural mismatch instead of a silent malfunction.

import type { Transaction, VersionedTransaction } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

export interface AnchorWalletLike {
  publicKey: PublicKey;
  signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>;
  signAllTransactions: <T extends Transaction | VersionedTransaction>(txs: T[]) => Promise<T[]>;
}

const SIGN_THROUGH_MWA = new Error(
  "Anchor.signTransaction was called on the MWA adapter. Mobile builds " +
    "must collect instructions via `.instruction()` and submit through " +
    "`mwa.signAndSendTransaction(authToken, tx, walletKind)` directly.",
);

/** Build an Anchor-compatible Wallet wrapper around an MWA-derived
 *  base58 wallet address. The wrapper carries no auth state — signing is
 *  out-of-band via MWA's signAndSendTransaction. */
export const makeAnchorAdapter = (walletAddress: string): AnchorWalletLike => {
  const publicKey = new PublicKey(walletAddress);
  return {
    publicKey,
    signTransaction: async () => {
      throw SIGN_THROUGH_MWA;
    },
    signAllTransactions: async () => {
      throw SIGN_THROUGH_MWA;
    },
  };
};
