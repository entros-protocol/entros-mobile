export type WalletKind = "phantom" | "solflare";

/** UX bucket for the /verify/failure screen. Maps from the parser's
 *  SubmitErrorKind via `processing.tsx`'s catch handler — multiple kinds can
 *  share a bucket (e.g. retry-now collects stale-blockhash + wallet-timeout
 *  + clock-drift + network-unreachable + challenge-stale). The bucket
 *  enumeration drives the screen's color/icon/copy/CTA decisions. */
export type FailureBucket =
  | "relayer-down" // /challenge or /validate-features unreachable / 5xx
  | "baseline-missing" // local baseline gone (or anchor-already-exists path); CTA = Reset
  | "rate-limited" // HTTP 429 from /validate-features; per-wallet quota ceiling
  | "chain-rate-limited" // entros-anchor cooldown (6012); 7-day reset gate
  | "insufficient-funds" // fee payer balance below verification_fee + rent
  | "validator-mismatch" // entros-anchor receipt-rejected family (6015-6021); Phase 5 hard-fail
  | "retry-now" // transient — congestion / wallet hung / RPC drop / clock skew; "Try again"
  | "capture-drift" // behavioral drift past the consistency ceiling; retry with a steady capture
  | "report-bug" // proof-rejected / programming-error; CTA = copy diagnostics
  | "generic"; // last resort

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
  /** Chain-derived list of every re-verification timestamp still present
   *  in the on-chain `recent_timestamps[N]` circular buffer (N=52 on
   *  current accounts, 10 on legacy). Sorted most-recent first. Empty
   *  on cold/unverified state. The activity tab renders this directly —
   *  it's the only on-chain source of "verification history" the
   *  protocol exposes. */
  recentTimestamps: Date[];
  /** Timestamp of the last `reset_identity_state` if any, else null. The
   *  activity tab renders a single distinct row for the reset event when
   *  this is non-null. */
  lastResetAt: Date | null;
}

export type MockPreset = "cold" | "connected-no-anchor" | "connected-with-anchor" | "high-score";
