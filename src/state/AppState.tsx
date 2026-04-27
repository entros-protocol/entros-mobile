import { createContext, useCallback, useContext, useEffect, useMemo, useReducer } from "react";

import { deleteSecure, getSecure, SecureKeys, setSecure } from "@/storage/secure";
import * as mwa from "@/wallet/mwa";

import { presets, MOCK_VALUES } from "./presets";
import {
  ConnectionState,
  FailureBucket,
  IdentityState,
  MockPreset,
  VerificationEvent,
  WalletKind,
} from "./types";

// Random suffix avoids collisions when two events fire within the same
// millisecond (`Date.now()` alone isn't unique under fast back-to-back
// dispatches). 6 random bytes = 48 bits of entropy, ample for a session
// history capped at 50 entries. Uses `crypto.getRandomValues` provided by the
// `react-native-get-random-values` polyfill loaded in `src/polyfills.ts`.
const eventId = (): string => {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (const b of bytes) suffix += b.toString(16).padStart(2, "0");
  return `evt-${suffix}`;
};

interface AppState {
  ready: boolean;
  hydrating: boolean;
  firstLaunch: boolean;
  connection: ConnectionState & { authToken: string | null; label: string | null };
  identity: IdentityState;
  history: VerificationEvent[];
  ui: {
    walletMenuOpen: boolean;
  };
  dev: {
    forceOutcome: "success" | FailureBucket | null;
  };
}

type Action =
  | {
      type: "hydrated";
      address: string | null;
      authToken: string | null;
      label: string | null;
      wallet: WalletKind | null;
    }
  | { type: "loadPreset"; preset: MockPreset }
  | { type: "completeOnboarding" }
  | {
      type: "connected";
      address: string;
      authToken: string;
      label: string | null;
      wallet: WalletKind | null;
    }
  | { type: "disconnected" }
  | { type: "verify"; trustDelta: number; txSignature: string }
  | { type: "fail"; bucket: FailureBucket }
  | { type: "resetBaseline" }
  | { type: "setWalletMenuOpen"; open: boolean }
  | { type: "setForceOutcome"; outcome: "success" | FailureBucket | null };

const initialState: AppState = {
  ready: false,
  hydrating: true,
  firstLaunch: true,
  connection: { connected: false, address: null, wallet: null, authToken: null, label: null },
  identity: presets["cold"].identity,
  history: [],
  ui: { walletMenuOpen: false },
  dev: { forceOutcome: null },
};

const reducer = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case "hydrated":
      return {
        ...state,
        ready: true,
        hydrating: false,
        firstLaunch: !action.address,
        connection: action.address
          ? {
              connected: true,
              address: action.address,
              wallet: action.wallet,
              authToken: action.authToken,
              label: action.label,
            }
          : state.connection,
      };
    case "loadPreset": {
      const data = presets[action.preset];
      return {
        ...state,
        ready: true,
        hydrating: false,
        ...data,
        connection: {
          ...data.connection,
          authToken: state.connection.authToken,
          label: state.connection.label,
        },
      };
    }
    case "completeOnboarding":
      return { ...state, firstLaunch: false };
    case "connected":
      return {
        ...state,
        connection: {
          connected: true,
          address: action.address,
          wallet: action.wallet,
          authToken: action.authToken,
          label: action.label,
        },
      };
    case "disconnected":
      return {
        ...state,
        connection: { connected: false, address: null, wallet: null, authToken: null, label: null },
      };
    case "verify": {
      const event: VerificationEvent = {
        id: eventId(),
        ts: new Date(),
        outcome: "verified",
        trustDelta: action.trustDelta,
        txSignature: action.txSignature,
      };
      const newScore = Math.min(100, state.identity.trustScore + action.trustDelta);
      return {
        ...state,
        identity: {
          ...state.identity,
          hasAnchor: true,
          trustScore: newScore,
          verifications: state.identity.verifications + 1,
          lastVerifiedAt: new Date(),
          commitment: state.identity.commitment ?? MOCK_VALUES.commitment,
          mint: state.identity.mint ?? MOCK_VALUES.mint,
          createdAt: state.identity.createdAt ?? new Date(),
        },
        history: [event, ...state.history].slice(0, 50),
      };
    }
    case "fail": {
      const event: VerificationEvent = {
        id: eventId(),
        ts: new Date(),
        outcome: "failed",
        trustDelta: 0,
        txSignature: null,
        failureBucket: action.bucket,
      };
      return { ...state, history: [event, ...state.history].slice(0, 50) };
    }
    case "resetBaseline":
      return {
        ...state,
        identity: presets["connected-no-anchor"].identity,
      };
    case "setWalletMenuOpen":
      return { ...state, ui: { ...state.ui, walletMenuOpen: action.open } };
    case "setForceOutcome":
      return { ...state, dev: { forceOutcome: action.outcome } };
    default:
      return state;
  }
};

interface AppStateContextValue extends AppState {
  loadPreset: (preset: MockPreset) => void;
  completeOnboarding: () => void;
  connect: (walletKind?: WalletKind) => Promise<void>;
  disconnect: () => Promise<void>;
  verify: (trustDelta: number, txSignature: string) => void;
  fail: (bucket: FailureBucket) => void;
  resetBaseline: () => void;
  openWalletMenu: () => void;
  closeWalletMenu: () => void;
  setForceOutcome: (outcome: "success" | FailureBucket | null) => void;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

export const AppStateProvider = ({ children }: { children: React.ReactNode }) => {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Cold-start hydration: load any persisted wallet credentials. We do not
  // re-authorize with MWA here — that would round-trip to the wallet app on
  // every launch. We trust the stored address until a signing operation needs
  // a fresh token, at which point reauthorize handles refresh / failure.
  useEffect(() => {
    const hydrate = async () => {
      try {
        const [address, authToken, label, walletKind] = await Promise.all([
          getSecure(SecureKeys.WALLET_ADDRESS),
          getSecure(SecureKeys.WALLET_AUTH_TOKEN),
          getSecure(SecureKeys.WALLET_LABEL),
          getSecure(SecureKeys.WALLET_KIND),
        ]);
        const wallet = walletKind === "phantom" || walletKind === "solflare" ? walletKind : null;
        dispatch({ type: "hydrated", address, authToken, label, wallet });
      } catch {
        dispatch({ type: "hydrated", address: null, authToken: null, label: null, wallet: null });
      }
    };
    void hydrate();
  }, []);

  const persist = useCallback(async (account: mwa.AuthorizedAccount) => {
    await Promise.all([
      setSecure(SecureKeys.WALLET_ADDRESS, account.address),
      setSecure(SecureKeys.WALLET_AUTH_TOKEN, account.authToken),
      account.label
        ? setSecure(SecureKeys.WALLET_LABEL, account.label)
        : deleteSecure(SecureKeys.WALLET_LABEL),
      account.wallet
        ? setSecure(SecureKeys.WALLET_KIND, account.wallet)
        : deleteSecure(SecureKeys.WALLET_KIND),
    ]);
  }, []);

  const clearStored = useCallback(async () => {
    await Promise.all([
      deleteSecure(SecureKeys.WALLET_ADDRESS),
      deleteSecure(SecureKeys.WALLET_AUTH_TOKEN),
      deleteSecure(SecureKeys.WALLET_LABEL),
      deleteSecure(SecureKeys.WALLET_KIND),
    ]);
  }, []);

  const connect = useCallback(
    async (walletKind?: WalletKind) => {
      const account = await mwa.connect(walletKind);
      await persist(account);
      dispatch({
        type: "connected",
        address: account.address,
        authToken: account.authToken,
        label: account.label,
        wallet: account.wallet,
      });
    },
    [persist],
  );

  const disconnect = useCallback(async () => {
    if (state.connection.authToken) {
      await mwa.disconnect(state.connection.authToken, state.connection.wallet);
    }
    await clearStored();
    dispatch({ type: "disconnected" });
  }, [clearStored, state.connection.authToken, state.connection.wallet]);

  const value = useMemo<AppStateContextValue>(
    () => ({
      ...state,
      loadPreset: (preset) => dispatch({ type: "loadPreset", preset }),
      completeOnboarding: () => dispatch({ type: "completeOnboarding" }),
      connect,
      disconnect,
      verify: (trustDelta, txSignature) => dispatch({ type: "verify", trustDelta, txSignature }),
      fail: (bucket) => dispatch({ type: "fail", bucket }),
      resetBaseline: () => dispatch({ type: "resetBaseline" }),
      openWalletMenu: () => dispatch({ type: "setWalletMenuOpen", open: true }),
      closeWalletMenu: () => dispatch({ type: "setWalletMenuOpen", open: false }),
      setForceOutcome: (outcome) => dispatch({ type: "setForceOutcome", outcome }),
    }),
    [state, connect, disconnect],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
};

export const useAppState = (): AppStateContextValue => {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used within AppStateProvider");
  return ctx;
};
