import { ConnectionState, IdentityState, MockPreset, VerificationEvent } from "./types";

const MOCK_ADDRESS = "7xKXtg2CWRQ5G5K1nQpA8FvLm3xZ5b9eVdJk2K8N4nQ";
const MOCK_MINT = "EntrosAnchor11111111111111111111111111111111";
const MOCK_COMMITMENT = "0xa3f1c2b9e4d5a6c7f0e8d9b1a2c3d4e5f6789abcdef0123456789abcdef9e2c";

export interface PresetData {
  firstLaunch: boolean;
  connection: ConnectionState;
  identity: IdentityState;
  history: VerificationEvent[];
}

const empty: PresetData = {
  firstLaunch: true,
  connection: { connected: false, address: null, wallet: null },
  identity: {
    hasAnchor: false,
    trustScore: 0,
    verifications: 0,
    lastVerifiedAt: null,
    commitment: null,
    mint: null,
    createdAt: null,
  },
  history: [],
};

const connected: PresetData = {
  ...empty,
  firstLaunch: false,
  connection: { connected: true, address: MOCK_ADDRESS, wallet: "phantom" },
};

const buildHistory = (count: number): VerificationEvent[] => {
  const now = Date.now();
  const events: VerificationEvent[] = [];
  for (let i = 0; i < count; i++) {
    const failed = i > 0 && i % 7 === 6;
    events.push({
      id: `evt-${i}`,
      ts: new Date(now - i * 60 * 60 * 1000 * 38),
      outcome: failed ? "failed" : "verified",
      trustDelta: failed ? 0 : i === 0 ? 0 : 2 + Math.floor(Math.random() * 3),
      txSignature: failed ? null : `${Math.random().toString(36).slice(2, 10)}…rY${i}x`,
      failureBucket: failed ? "relayer-down" : undefined,
    });
  }
  return events;
};

const withAnchor: PresetData = {
  ...connected,
  identity: {
    hasAnchor: true,
    trustScore: 18,
    verifications: 4,
    lastVerifiedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    commitment: MOCK_COMMITMENT,
    mint: MOCK_MINT,
    createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
  },
  history: buildHistory(4),
};

const high: PresetData = {
  ...connected,
  identity: {
    hasAnchor: true,
    trustScore: 87,
    verifications: 22,
    lastVerifiedAt: new Date(Date.now() - 90 * 60 * 1000),
    commitment: MOCK_COMMITMENT,
    mint: MOCK_MINT,
    createdAt: new Date(Date.now() - 96 * 24 * 60 * 60 * 1000),
  },
  history: buildHistory(22),
};

export const presets: Record<MockPreset, PresetData> = {
  cold: empty,
  "connected-no-anchor": connected,
  "connected-with-anchor": withAnchor,
  "high-score": high,
};

export const MOCK_VALUES = {
  address: MOCK_ADDRESS,
  mint: MOCK_MINT,
  commitment: MOCK_COMMITMENT,
} as const;
