import { Cluster, Connection, PublicKey } from "@solana/web3.js";

const required = (name: string, value: string | undefined): string => {
  if (!value || value.length === 0) {
    throw new Error(`Missing env var ${name}. Copy .env.example to .env and fill in the values.`);
  }
  return value;
};

const optional = (value: string | undefined): string | null =>
  value && value.length > 0 ? value : null;

const parseProgramId = (name: string, raw: string | undefined): PublicKey | null => {
  const value = optional(raw);
  if (!value) return null;
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`Env var ${name} is not a valid base58 PublicKey: ${value}`);
  }
};

export const config = {
  rpcUrl: required("EXPO_PUBLIC_SOLANA_RPC", process.env.EXPO_PUBLIC_SOLANA_RPC),
  cluster: (process.env.EXPO_PUBLIC_SOLANA_CLUSTER ?? "devnet") as Cluster,
  programs: {
    entrosAnchor: parseProgramId(
      "EXPO_PUBLIC_ENTROS_ANCHOR_PROGRAM_ID",
      process.env.EXPO_PUBLIC_ENTROS_ANCHOR_PROGRAM_ID,
    ),
    entrosVerifier: parseProgramId(
      "EXPO_PUBLIC_ENTROS_VERIFIER_PROGRAM_ID",
      process.env.EXPO_PUBLIC_ENTROS_VERIFIER_PROGRAM_ID,
    ),
    entrosRegistry: parseProgramId(
      "EXPO_PUBLIC_ENTROS_REGISTRY_PROGRAM_ID",
      process.env.EXPO_PUBLIC_ENTROS_REGISTRY_PROGRAM_ID,
    ),
  },
  relayerUrl: optional(process.env.EXPO_PUBLIC_RELAYER_URL),
} as const;

let cachedConnection: Connection | null = null;

export const getConnection = (): Connection => {
  if (!cachedConnection) {
    cachedConnection = new Connection(config.rpcUrl, "confirmed");
  }
  return cachedConnection;
};
