import { config } from "@/config";

const clusterParam = (): string => {
  switch (config.cluster) {
    case "mainnet-beta":
      return "";
    case "testnet":
      return "?cluster=testnet";
    case "devnet":
    default:
      return "?cluster=devnet";
  }
};

export const explorerUrlForAddress = (address: string): string =>
  `https://explorer.solana.com/address/${address}${clusterParam()}`;

export const explorerTxUrl = (signature: string): string =>
  `https://explorer.solana.com/tx/${signature}${clusterParam()}`;
