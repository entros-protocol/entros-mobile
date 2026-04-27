export type WalletKind = "phantom" | "solflare";

export type FailureBucket = "relayer-down" | "baseline-missing" | "generic";

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
