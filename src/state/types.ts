export type WalletKind = "phantom" | "solflare";

export type FailureBucket = "relayer-down" | "baseline-missing" | "generic" | "rate-limited";

/** Whether the next verify cycle should mint/update the anchor (verify) or
 *  call reset_identity_state (reset). Set by the "Reset baseline" CTA on
 *  /verify/failure when bucket="baseline-missing"; consumed and cleared by
 *  /verify/processing when the on-chain submit lands. */
export type VerifyIntent = "verify" | "reset";

export interface VerificationEvent {
  id: string;
  ts: Date;
  outcome: "verified" | "failed";
  trustDelta: number;
  txSignature: string | null;
  failureBucket?: FailureBucket;
}

export interface ConnectionState {
  connected: boolean;
  address: string | null;
  wallet: WalletKind | null;
}

export interface IdentityState {
  hasAnchor: boolean;
  trustScore: number;
  verifications: number;
  lastVerifiedAt: Date | null;
  commitment: string | null;
  mint: string | null;
  createdAt: Date | null;
}

export type MockPreset = "cold" | "connected-no-anchor" | "connected-with-anchor" | "high-score";
