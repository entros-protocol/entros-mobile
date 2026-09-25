import type {
  Account,
  AuthorizationResult,
  WalletAssociationConfig,
} from "@solana-mobile/mobile-wallet-adapter-protocol";
import { transact, Web3MobileWallet } from "@solana-mobile/mobile-wallet-adapter-protocol-web3js";
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { Linking, Platform } from "react-native";

import { config } from "@/config";
import type { WalletKind } from "@/state/types";

import { extractVerifiedMessageSignature } from "./signedMessage";

// `icon` is omitted intentionally. Phantom's current build rejects every
// non-data-URL form we tried (`code=-32602, "identity.icon must be a relative
// URI"`): `/logos/Entros.png`, `logos/Entros.png`, and `https://...` all fire.
// Inline base64 data URIs over a few KB crash Phantom outright. Without `icon`,
// the wallet uses its default avatar and connection succeeds. A custom icon
// requires separate parser and size-limit tests for each wallet.
const APP_IDENTITY = {
  name: "Entros",
  uri: "https://entros.io",
} as const;

// Universal-link prefix each wallet registers with Android. The MWA SDK appends
// `/v1/associate/local` to this base, so `https://phantom.app/ul/v1` becomes
// `https://phantom.app/ul/v1/v1/associate/local?…` — the exact path Phantom
// and Solflare register their intent filters against. Dropping the trailing
// `/v1` produces a path neither filter matches and the deep link silently
// resolves to the wallet's home screen instead of the MWA approval flow.
const WALLET_URI_BASE: Record<WalletKind, string> = {
  phantom: "https://phantom.app/ul/v1",
  solflare: "https://solflare.com/ul/v1",
};

// Android package names. Used for both Intent.setPackage() (forces dispatch
// to a specific wallet APK; see `transactConfig` below) and the Play Store
// deep link (see `openWalletPlayStore`).
const WALLET_PACKAGE: Record<WalletKind, string> = {
  phantom: "app.phantom",
  solflare: "com.solflare.mobile",
};

// Build the transact() config. `baseUri` matches the wallet's intent filter so
// the OS knows which app's filter accepts the URL; `walletPackage` is read by
// our patched native MWA module and forces `Intent.setPackage()` so dispatch
// goes straight to that APK. Without setPackage, an unverified wallet domain
// (e.g. `phantom.app` not auto-verified on the device) would route the URL
// through the default browser instead. The patch lives at
// `patches/@solana-mobile+mobile-wallet-adapter-protocol+2.2.9.patch`.
const transactConfig = (
  walletKind: WalletKind | null | undefined,
): WalletAssociationConfig | undefined => {
  if (!walletKind) return undefined;
  // `walletPackage` is consumed by the patched native module via the underlying
  // ReadableMap; it isn't part of WalletAssociationConfig's public TS shape.
  return {
    baseUri: WALLET_URI_BASE[walletKind],
    walletPackage: WALLET_PACKAGE[walletKind],
  } as WalletAssociationConfig;
};

const WALLET_DISPLAY_NAME: Record<WalletKind, string> = {
  phantom: "Phantom",
  solflare: "Solflare",
};

// 120s gives the wallet's native approval UI room to surface its own errors
// (the underlying MWA client timeout is ~90s). A shorter JS-side timeout would
// pre-empt legitimate slow approvals on low-end devices and surface a misleading
// "wallet not installed" alert. The not-installed case is detected separately
// via the SolanaMobileWalletAdapterError.code === "ERROR_WALLET_NOT_FOUND" path,
// which fires in milliseconds — this timer's job is the genuine "wallet hung"
// recovery only.
const MWA_TIMEOUT_MS = 120_000;

export interface AuthorizedAccount {
  address: string; // base58
  label: string | null;
  authToken: string;
  wallet: WalletKind | null;
}

export class MWAWalletNotInstalledError extends Error {
  constructor(public readonly wallet: WalletKind) {
    super(`${WALLET_DISPLAY_NAME[wallet]} is not installed on this device.`);
    this.name = "MWAWalletNotInstalledError";
  }
}

export class MWATimeoutError extends Error {
  constructor(public readonly wallet: WalletKind | null) {
    super(
      wallet
        ? `${WALLET_DISPLAY_NAME[wallet]} did not respond in time. It may not be installed, or its association URL is unavailable.`
        : "The wallet did not respond in time.",
    );
    this.name = "MWATimeoutError";
  }
}

export const openWalletPlayStore = async (wallet: WalletKind): Promise<void> => {
  const pkg = WALLET_PACKAGE[wallet];
  const market = `market://details?id=${pkg}`;
  const web = `https://play.google.com/store/apps/details?id=${pkg}`;
  try {
    if (await Linking.canOpenURL(market)) {
      await Linking.openURL(market);
      return;
    }
  } catch {
    // fall through to web URL
  }
  await Linking.openURL(web);
};

export class MWAUnsupportedError extends Error {
  constructor() {
    super("Mobile Wallet Adapter is supported on Android only.");
    this.name = "MWAUnsupportedError";
  }
}

export class MWAUserRejectedError extends Error {
  constructor() {
    super("Wallet connection was cancelled.");
    this.name = "MWAUserRejectedError";
  }
}

// Wallet returned ERROR_AUTHORIZATION_FAILED (JSON-RPC code -1) before showing
// any approval UI. In practice this is the wallet's active network (mainnet /
// devnet / testnet) not matching the dApp's requested cluster — the rejection
// fires in <20ms. The UI layer surfaces wallet-specific repair instructions.
export class MWAAuthorizationFailedError extends Error {
  constructor() {
    super("Wallet rejected the connection before showing approval.");
    this.name = "MWAAuthorizationFailedError";
  }
}

const ensureAndroid = (): void => {
  if (Platform.OS !== "android") throw new MWAUnsupportedError();
};

const clusterForMwa = (): "devnet" | "testnet" | "mainnet-beta" => {
  switch (config.cluster) {
    case "devnet":
    case "testnet":
    case "mainnet-beta":
      return config.cluster;
    default:
      return "devnet";
  }
};

// MWA returns account.address as a base64-encoded ed25519 public key. We
// always decode it ourselves rather than reading the optional `publicKey` field
// some variants attach, because the field's type drift across protocol
// versions makes a defensive cast unsound.
const toBase58 = (account: Account): string => {
  const bytes = Uint8Array.from(atob(account.address), (c) => c.charCodeAt(0));
  return new PublicKey(bytes).toBase58();
};

const accountFromAuth = (
  auth: AuthorizationResult,
  wallet: WalletKind | null,
): AuthorizedAccount => {
  const account = auth.accounts[0];
  if (!account) {
    throw new Error("Wallet returned an empty accounts list.");
  }
  return {
    address: toBase58(account),
    label: account.label ?? null,
    authToken: auth.auth_token,
    wallet,
  };
};

const withTimeout = <T>(promise: Promise<T>, ms: number, kind: WalletKind | null): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new MWATimeoutError(kind)), ms);
  });
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeout,
  ]) as Promise<T>;
};

export const connect = async (walletKind?: WalletKind): Promise<AuthorizedAccount> => {
  ensureAndroid();

  try {
    return await withTimeout(
      transact(async (wallet: Web3MobileWallet) => {
        const auth = await wallet.authorize({
          cluster: clusterForMwa(),
          identity: APP_IDENTITY,
        });
        return accountFromAuth(auth, walletKind ?? null);
      }, transactConfig(walletKind)),
      MWA_TIMEOUT_MS,
      walletKind ?? null,
    );
  } catch (err) {
    if (err instanceof MWATimeoutError) throw err;
    if (err instanceof MWAWalletNotInstalledError) throw err;

    const e = err as { code?: string | number; message?: string };

    // JSON-RPC -1 (ERROR_AUTHORIZATION_FAILED). Wallet declined pre-UI;
    // the UI layer surfaces a network-mismatch hint as the most likely cause.
    if (
      e.code === -1 ||
      /authorization\s*failed|ERROR_AUTHORIZATION_FAILED/i.test(e.message ?? "")
    ) {
      throw new MWAAuthorizationFailedError();
    }

    if (err instanceof Error && /reject|cancel/i.test(err.message)) {
      throw new MWAUserRejectedError();
    }

    // No installed wallet matches the intent. Canonical code first, then
    // message-string fallback for older protocol versions that don't propagate
    // the code through the JS bridge.
    if (walletKind && err instanceof Error) {
      const code = (err as { code?: string }).code;
      if (
        code === "ERROR_WALLET_NOT_FOUND" ||
        /no\s+activity|not\s+found|wallet\s*not\s*found|no\s+app|ActivityNotFound/i.test(
          err.message,
        )
      ) {
        throw new MWAWalletNotInstalledError(walletKind);
      }
    }
    throw err;
  }
};

export const reauthorize = async (
  authToken: string,
  walletKind?: WalletKind | null,
): Promise<AuthorizedAccount> => {
  ensureAndroid();
  return transact(async (wallet: Web3MobileWallet) => {
    const auth = await wallet.reauthorize({ auth_token: authToken, identity: APP_IDENTITY });
    return accountFromAuth(auth, walletKind ?? null);
  }, transactConfig(walletKind));
};

export const disconnect = async (
  authToken: string,
  walletKind?: WalletKind | null,
): Promise<void> => {
  ensureAndroid();
  try {
    await transact(async (wallet: Web3MobileWallet) => {
      await wallet.deauthorize({ auth_token: authToken });
    }, transactConfig(walletKind));
  } catch {
    // The wallet may already be uninstalled, the token expired, or the user
    // denied the deauthorize prompt. Either way the local state is what the
    // user sees in-app — clearing it is the caller's responsibility, not the
    // wallet's. Surfacing this error would only confuse the disconnect UX.
  }
};

export interface SignAndSendResult {
  signature: string;
  // MWA's spec allows wallets to rotate auth_token on every reauthorize. Callers
  // MUST persist this back to secure storage to keep the next session working.
  authToken: string;
}

export interface SignMessageResult {
  signature: Uint8Array;
  authToken: string;
}

export type AuthTokenRotationHandler = (authToken: string) => void | Promise<void>;

export const signMessage = async (
  authToken: string,
  message: Uint8Array,
  expectedWalletAddress: string,
  walletKind?: WalletKind | null,
  timeoutMs = MWA_TIMEOUT_MS,
  onAuthTokenRotated?: AuthTokenRotationHandler,
): Promise<SignMessageResult> => {
  ensureAndroid();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Validation challenge expired before wallet authorization.");
  }
  return withTimeout(
    transact(async (wallet: Web3MobileWallet) => {
      const auth = await wallet.reauthorize({ auth_token: authToken, identity: APP_IDENTITY });
      const account = accountFromAuth(auth, walletKind ?? null);
      if (account.address !== expectedWalletAddress) {
        throw new Error("Validation wallet does not match the connected wallet.");
      }
      await onAuthTokenRotated?.(auth.auth_token);
      const protocolAccount = auth.accounts[0];
      if (!protocolAccount) throw new Error("Wallet returned an empty accounts list.");
      const [signedPayload] = await wallet.signMessages({
        addresses: [protocolAccount.address],
        payloads: [message],
      });
      if (!signedPayload) throw new Error("Wallet returned no signed validation message.");
      const publicKey = new PublicKey(expectedWalletAddress).toBytes();
      return {
        signature: extractVerifiedMessageSignature(message, signedPayload, publicKey),
        authToken: auth.auth_token,
      };
    }, transactConfig(walletKind)),
    Math.min(MWA_TIMEOUT_MS, timeoutMs),
    walletKind ?? null,
  );
};

export const signAndSendTransaction = async (
  authToken: string,
  tx: Transaction | VersionedTransaction,
  expectedWalletAddress: string,
  walletKind?: WalletKind | null,
  onAuthTokenRotated?: AuthTokenRotationHandler,
): Promise<SignAndSendResult> => {
  ensureAndroid();
  return transact(async (wallet: Web3MobileWallet) => {
    const auth = await wallet.reauthorize({ auth_token: authToken, identity: APP_IDENTITY });
    const account = accountFromAuth(auth, walletKind ?? null);
    if (account.address !== expectedWalletAddress) {
      throw new Error("Transaction wallet does not match the connected wallet.");
    }
    await onAuthTokenRotated?.(auth.auth_token);
    const [signature] = await wallet.signAndSendTransactions({ transactions: [tx] });
    if (!signature) {
      throw new Error("Wallet returned no transaction signature.");
    }
    return { signature, authToken: auth.auth_token };
  }, transactConfig(walletKind));
};
