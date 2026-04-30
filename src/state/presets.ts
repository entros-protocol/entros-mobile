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
    recentTimestamps: [],
    lastResetAt: null,
  },
  history: [],
};

const connected: PresetData = {
  ...empty,
  firstLaunch: false,
  connection: { connected: true, address: MOCK_ADDRESS, wallet: "phantom" },
};

/** Build a chain of recent_timestamps spaced 38h apart, mirroring how the
 *  on-chain circular buffer would look for a wallet that re-verifies on a
 *  ~daily-ish cadence. Used by the demo presets so the activity tab has
 *  data to render. The on-chain field caps at N entries (52 currently),
 *  so we cap demo lists too. */
const buildRecentTimestamps = (count: number): Date[] => {
  const now = Date.now();
  const out: Date[] = [];
  const cap = Math.min(count, 52);
  for (let i = 0; i < cap; i += 1) {
    out.push(new Date(now - i * 60 * 60 * 1000 * 38));
  }
  return out;
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
    recentTimestamps: buildRecentTimestamps(4),
    lastResetAt: null,
  },
  history: [],
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
    recentTimestamps: buildRecentTimestamps(22),
    lastResetAt: null,
  },
  history: [],
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
