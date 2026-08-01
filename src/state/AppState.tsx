import { PublicKey } from "@solana/web3.js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";

import { config, getConnection } from "@/config";
import { wipeBaseline } from "@/identity/baseline";
import { devWarn } from "@/lib/log";
import { fetchIdentityState, toAppStateIdentity } from "@/protocol/identity";
import { deleteSecure, getSecure, SecureKeys, setSecure } from "@/storage/secure";
import * as mwa from "@/wallet/mwa";

/**
 * Width of one Trust Score activity bin, mirroring `BIN_SIZE_SECS` in
 * entros-anchor. The on-chain ring records at most one timestamp per bin, so
 * anything that predicts what the chain will hold has to use the same width.
 */
const SCORING_BIN_MS = 7 * 24 * 60 * 60 * 1000;

import { presets } from "./presets";
import {
  ConnectionState,
  FailureBucket,
  IdentityState,
  MockPreset,
  VerificationEvent,
  VerifyIntent,
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
  flow: {
    /** Whether the next verify cycle is a normal verify (mint or update) or
     *  a baseline reset (reset_identity_state). Defaults to "verify"; the
     *  failure screen flips to "reset" when the user taps Reset baseline. */
    intent: VerifyIntent;
  };
  dev: {
    forceOutcome: "success" | FailureBucket | null;
    /** Currently-active demo preset, or null when the app is showing real
     *  state. When non-null, `hydrateIdentity` becomes a no-op so the
     *  on-chain RPC fetch on dashboard focus / verify-success doesn't
     *  clobber the demo state. Toggling the same preset again clears this
     *  and restores the snapshot below. */
    activePreset: MockPreset | null;
    /** Snapshot of `connection`, `identity`, `firstLaunch`, and `history`
     *  taken just before the FIRST preset is applied. Restored verbatim
     *  when the preset toggles off. Stays present while the user switches
     *  between presets so a A→B→A flow doesn't lose the original real
     *  state. Cleared on `disconnected` (the snapshot would be stale once
     *  the wallet changes). */
    snapshot: {
      connection: AppState["connection"];
      identity: IdentityState;
      firstLaunch: boolean;
      history: VerificationEvent[];
    } | null;
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
  | { type: "clearPreset" }
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
  | { type: "resetComplete"; txSignature: string }
  | { type: "fail"; bucket: FailureBucket }
  | { type: "resetBaseline" }
  | { type: "setWalletMenuOpen"; open: boolean }
  | { type: "setFlowIntent"; intent: VerifyIntent }
  | { type: "setForceOutcome"; outcome: "success" | FailureBucket | null }
  | { type: "hydrateIdentity"; identity: IdentityState }
  | { type: "hydrateIdentityCold" };

const initialState: AppState = {
  ready: false,
  hydrating: true,
  firstLaunch: true,
  connection: { connected: false, address: null, wallet: null, authToken: null, label: null },
  identity: presets["cold"].identity,
  history: [],
  ui: { walletMenuOpen: false },
  flow: { intent: "verify" },
  dev: { forceOutcome: null, activePreset: null, snapshot: null },
};

const reducer = (state: AppState, action: Action): AppState => {
  switch (action.type) {
    case "hydrated":
      // Cold-start init from secure-store. On a real cold start the
      // initialState already has `dev` cleared; the explicit reset here
      // is defensive against Fast-Refresh sessions where the in-memory
      // `dev` slice may have survived a code edit with stale preset
      // state. No-op in production, prevents stuck-preview-mode in dev.
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
        dev: { ...state.dev, activePreset: null, snapshot: null },
      };
    case "loadPreset": {
      const data = presets[action.preset];
      // First preset application captures a snapshot so we can restore the
      // real state on toggle-off. Subsequent preset switches keep the
      // ORIGINAL snapshot so `A → B → off` lands back on real state, not on
      // preset A.
      const snapshot =
        state.dev.snapshot ??
        ({
          connection: state.connection,
          identity: state.identity,
          firstLaunch: state.firstLaunch,
          history: state.history,
        } as AppState["dev"]["snapshot"]);
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
        dev: {
          ...state.dev,
          activePreset: action.preset,
          snapshot,
        },
      };
    }
    case "clearPreset": {
      // Restore the snapshot taken when the FIRST preset was applied. If
      // there's no snapshot we just clear the activePreset flag — the
      // preset can't have been active in any meaningful sense without a
      // captured snapshot. Both branches end with snapshot = null for
      // contract symmetry.
      if (!state.dev.snapshot) {
        return { ...state, dev: { ...state.dev, activePreset: null, snapshot: null } };
      }
      return {
        ...state,
        connection: state.dev.snapshot.connection,
        identity: state.dev.snapshot.identity,
        firstLaunch: state.dev.snapshot.firstLaunch,
        history: state.dev.snapshot.history,
        dev: { ...state.dev, activePreset: null, snapshot: null },
      };
    }
    case "completeOnboarding":
      return { ...state, firstLaunch: false };
    case "connected":
      // A real wallet connect supersedes any active demo preset — the user
      // is no longer "previewing"; they just authorised on-chain identity.
      // Drop the activePreset highlight and the snapshot so subsequent
      // hydrate calls reflect the live connection without restoring stale
      // preset state. Without this, the settings panel kept the prior
      // preset glowing as ACTIVE even after a fresh connection landed.
      return {
        ...state,
        connection: {
          connected: true,
          address: action.address,
          wallet: action.wallet,
          authToken: action.authToken,
          label: action.label,
        },
        dev: { ...state.dev, activePreset: null, snapshot: null },
      };
    case "disconnected":
      // A disconnect must reset the identity and history slices alongside
      // the connection. Otherwise the next wallet briefly inherits the old
      // wallet's dashboard state until hydrateIdentity completes (200-400ms
      // RPC), and the history feed leaks the old session's verifications
      // into the new wallet's UI. The cold preset's identity matches the
      // shape used by hydrateIdentityCold. Also clear any active demo
      // preset + its snapshot — the snapshot was taken against the prior
      // wallet's state and is stale post-disconnect.
      return {
        ...state,
        connection: { connected: false, address: null, wallet: null, authToken: null, label: null },
        identity: presets["cold"].identity,
        history: [],
        dev: { ...state.dev, activePreset: null, snapshot: null },
      };
    case "verify": {
      const now = new Date();
      const event: VerificationEvent = {
        id: eventId(),
        ts: now,
        outcome: "verified",
        trustDelta: action.trustDelta,
        txSignature: action.txSignature,
      };
      const newScore = Math.min(100, state.identity.trustScore + action.trustDelta);
      // Optimistically push the new timestamp onto the chain-derived
      // `recentTimestamps` buffer so the activity tab shows the row before
      // hydrateIdentity reconciles. Defensive `?? []` for Fast-Refresh
      // sessions where the in-memory identity object pre-dates the field. The
      // alternative `...undefined` would throw and crash the verify flow.
      //
      // The gate mirrors `record_verification` in entros-anchor: the ring
      // holds at most one entry per weekly scoring bin, so a second
      // verification inside the same week is not written on chain. Pushing it
      // here anyway would show a row that hydrate then removes.
      const prior = state.identity.recentTimestamps ?? [];
      const newestPrior = prior[0]?.getTime();
      const opensNewBin =
        newestPrior === undefined ||
        now.getTime() - newestPrior >= SCORING_BIN_MS;
      const recentTimestamps = opensNewBin
        ? [now, ...prior].slice(0, 52)
        : prior;
      return {
        ...state,
        identity: {
          ...state.identity,
          hasAnchor: true,
          trustScore: newScore,
          verifications: state.identity.verifications + 1,
          lastVerifiedAt: now,
          // Leave commitment / mint at null when chain values haven't
          // arrived yet. Hydrate fills them from the on-chain mint a few
          // hundred ms later. Showing MOCK_VALUES briefly is misleading —
          // the dashboard's `truncate(...)` would render the hardcoded
          // mock hex as if it were the user's real commitment.
          commitment: state.identity.commitment,
          mint: state.identity.mint,
          createdAt: state.identity.createdAt ?? now,
          recentTimestamps,
        },
        history: [event, ...state.history].slice(0, 50),
      };
    }
    case "resetComplete": {
      // On-chain reset_identity_state succeeded. Optimistic local update
      // mirroring the on-chain semantics so the UI reflects the reset
      // immediately: trust_score → 0, verifications → 0, lastVerifiedAt →
      // now, recent_timestamps cleared (we don't track those locally).
      // hasAnchor stays true (the SPL token mint isn't burned). The
      // verify success screen calls hydrateIdentity on mount which
      // reconciles this optimistic state against the on-chain truth.
      const event: VerificationEvent = {
        id: eventId(),
        ts: new Date(),
        outcome: "verified",
        trustDelta: 0,
        txSignature: action.txSignature,
      };
      const now = new Date();
      return {
        ...state,
        identity: {
          ...state.identity,
          trustScore: 0,
          verifications: 0,
          lastVerifiedAt: now,
          // reset_identity_state clears the on-chain ring buffer; mirror
          // that locally so the activity tab updates immediately. The reset
          // event itself is rendered from `lastResetAt` below.
          recentTimestamps: [],
          lastResetAt: now,
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
    case "setFlowIntent":
      return { ...state, flow: { intent: action.intent } };
    case "setForceOutcome":
      return { ...state, dev: { ...state.dev, forceOutcome: action.outcome } };
    case "hydrateIdentity":
      return { ...state, identity: action.identity };
    case "hydrateIdentityCold":
      // No on-chain identity exists yet — reset to the cold-state preset's
      // identity slice so the dashboard renders the "Mint Entros Anchor"
      // CTA. Connection / history / flow intent / dev forceOutcome are
      // preserved (this is reconciliation, not a logout).
      return { ...state, identity: presets["cold"].identity };
    default:
      return state;
  }
};

interface AppStateContextValue extends AppState {
  loadPreset: (preset: MockPreset) => void;
  /** Clears any active demo preset and restores the snapshot taken before
   *  the first preset application. After clearing, callers typically fire
   *  `hydrateIdentity()` to refresh the identity slice from chain. */
  clearPreset: () => void;
  completeOnboarding: () => void;
  connect: (walletKind?: WalletKind) => Promise<void>;
  disconnect: () => Promise<void>;
  verify: (trustDelta: number, txSignature: string) => void;
  resetComplete: (txSignature: string) => void;
  fail: (bucket: FailureBucket) => void;
  resetBaseline: () => void;
  openWalletMenu: () => void;
  closeWalletMenu: () => void;
  setFlowIntent: (intent: VerifyIntent) => void;
  setForceOutcome: (outcome: "success" | FailureBucket | null) => void;
  /** Refreshes the in-memory `identity` slice from the on-chain
   *  `IdentityState` PDA. Idempotent and fire-and-forget safe — callers
   *  invoke from dashboard focus, post-connect, and post-verify so the UI
   *  reflects on-chain truth instead of optimistic local mutations.
   *  Resolves to true if an account was found (identity hydrated), false
   *  if the wallet has no anchor yet (cold-state UI). Errors are swallowed
   *  with a devWarn — the existing UI state survives.
   *  `opts.force` bypasses the demo-mode gate (active preset would
   *  otherwise skip the fetch); use it when the caller just dispatched a
   *  state change that clears the preset but the reducer hasn't re-flushed
   *  through `stateRef` yet. */
  hydrateIdentity: (opts?: { force?: boolean }) => Promise<boolean>;
}

const AppStateContext = createContext<AppStateContextValue | null>(null);

export const AppStateProvider = ({ children }: { children: React.ReactNode }) => {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Latest-state ref. Refreshed synchronously on every render so callbacks
  // can read connection.address / connected at call time without subscribing
  // to those fields in their useCallback deps. The alternative (closing
  // over state.connection.*) would create a new hydrateIdentity reference
  // on every reducer dispatch, which in turn would re-fire any useEffect /
  // useFocusEffect with hydrateIdentity in its deps — a tight loop given
  // that hydrateIdentity itself dispatches.
  const stateRef = useRef(state);
  stateRef.current = state;

  // Single in-flight hydrate guard. Connect → dashboard focus and verify
  // success → dashboard focus both fire hydrateIdentity within a few
  // milliseconds; without de-dup we'd double-fetch the same PDA. Concurrent
  // callers receive the same promise and observe a single dispatch.
  const inflightHydrateRef = useRef<Promise<boolean> | null>(null);

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

  // hydrateIdentityFor is defined before `connect` so the post-connect
  // refresh can reach it. The explicit address arg lets the caller pass a
  // freshly-authorized wallet without waiting for the reducer's `connected`
  // dispatch to flush through the closure. Empty deps keep the function
  // referentially stable across reducer dispatches.
  const hydrateIdentityFor = useCallback(
    async (address: string, opts?: { force?: boolean }): Promise<boolean> => {
      if (!config.programs.entrosAnchor) {
        devWarn("[Entros] EXPO_PUBLIC_ENTROS_ANCHOR_PROGRAM_ID unset; skipping hydrate");
        return false;
      }
      // Demo-mode gate: when a dev preset is active, skip the on-chain
      // fetch entirely so the preset's mock identity stays visible.
      // Without this, dashboard focus / verify-success would silently
      // overwrite the preset with on-chain truth (or with cold-state
      // if the wallet has no anchor). `!= null` (not `!== null`) so
      // undefined gets treated as "no preset active" — handles dev-only
      // Fast-Refresh where the in-memory `dev` slice may pre-date the
      // field's introduction.
      // The `force` opt-out exists for explicit connect/reset/verify
      // call sites: those dispatch a state-changing action immediately
      // before invoking us, but `stateRef.current` still reflects the
      // PREVIOUS render's `dev.activePreset` (React hasn't re-rendered
      // between sync dispatch and our gate check). Forcing past the gate
      // lets a fresh wallet auth populate the dashboard even when the
      // user was just previewing a preset.
      if (!opts?.force && stateRef.current.dev?.activePreset != null) {
        return false;
      }
      if (inflightHydrateRef.current) return inflightHydrateRef.current;

      const promise = (async (): Promise<boolean> => {
        try {
          const onChain = await fetchIdentityState(new PublicKey(address), getConnection());
          // Mid-flight wallet-swap guard: if the user disconnected and
          // reconnected to a different wallet while we were fetching,
          // drop the result rather than overwrite the new wallet's
          // identity with stale data from the old wallet. Reads stateRef
          // instead of state.connection so the fetch sees the current
          // address even when the call site captured an older closure.
          if (stateRef.current.connection.address !== address) return false;
          if (onChain) {
            dispatch({ type: "hydrateIdentity", identity: toAppStateIdentity(onChain) });
            return true;
          }
          dispatch({ type: "hydrateIdentityCold" });
          return false;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          devWarn(`[Entros] hydrateIdentity failed: ${message}`);
          return false;
        } finally {
          inflightHydrateRef.current = null;
        }
      })();

      inflightHydrateRef.current = promise;
      return promise;
    },
    [],
  );

  // hydrateIdentity reads connection from stateRef so the function reference
  // stays stable across reducer dispatches. Effects with hydrateIdentity in
  // their dep array (dashboard useFocusEffect, verify-success useEffect)
  // fire on real focus / mount transitions only, not on incidental state
  // mutations from elsewhere in the tree.
  //
  // The `force` opt-out exists for callers who just dispatched a
  // state-changing action and want a refresh without the demo-mode gate
  // tripping on the still-stale stateRef. Settings' "tap-active-preset-
  // again-to-toggle-off" path is the canonical case: the prior dispatch
  // (`clearPreset`) sets `dev.activePreset = null` in the reducer, but
  // this function reads `stateRef.current` which still points at the
  // previous render. Without `force`, the gate would block the refresh
  // and the user would see stale state until the next focus event.
  const hydrateIdentity = useCallback(
    async (opts?: { force?: boolean }): Promise<boolean> => {
      const conn = stateRef.current.connection;
      if (!conn.connected || !conn.address) return false;
      return hydrateIdentityFor(conn.address, opts);
    },
    [hydrateIdentityFor],
  );

  const connect = useCallback(
    async (walletKind?: WalletKind) => {
      const account = await mwa.connect(walletKind);
      await persist(account);
      // The `connected` reducer clears any active preset/snapshot in the
      // same dispatch, so a separate `clearPreset` dispatch first would
      // be redundant — and would briefly restore the snapshot's (typically
      // disconnected) state for one render before `connected` overwrites
      // it. The `force: true` on hydrate below handles the stateRef
      // staleness window without needing a second dispatch.
      dispatch({
        type: "connected",
        address: account.address,
        authToken: account.authToken,
        label: account.label,
        wallet: account.wallet,
      });
      // Reconcile the dashboard with on-chain truth BEFORE returning, so
      // the caller (`/connect.tsx`) only navigates to `/(app)` once the
      // identity slice reflects chain state. Without the await, the
      // dashboard mounts with the cold-state placeholder and only flips
      // to real data 200-400ms later, which reads as "stats didn't load"
      // on the connect-then-land path. The `force: true` bypasses the
      // demo-mode gate — the `connected` reducer above just cleared
      // `dev.activePreset`, but `stateRef.current` reflects the previous
      // render's state because React hasn't re-rendered yet. Without the
      // force, a user previewing the cold preset who then connects for
      // real would land on the dashboard with the preset's cold identity
      // still rendered. The added latency is bounded by `getAccountInfo`
      // (~200-400ms on warm RPC) — well under the perceived settling
      // window post-Phantom-approval.
      await hydrateIdentityFor(account.address, { force: true });
    },
    [persist, hydrateIdentityFor],
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
      clearPreset: () => dispatch({ type: "clearPreset" }),
      completeOnboarding: () => dispatch({ type: "completeOnboarding" }),
      connect,
      disconnect,
      verify: (trustDelta, txSignature) => dispatch({ type: "verify", trustDelta, txSignature }),
      resetComplete: (txSignature) => dispatch({ type: "resetComplete", txSignature }),
      fail: (bucket) => dispatch({ type: "fail", bucket }),
      resetBaseline: () => {
        // Fire-and-forget the secure-store wipe. The reducer state change is
        // synchronous so the UI updates immediately; the wipe happens in
        // parallel and clears both the AES envelope and the key. A real I/O
        // failure here is unusual but worth surfacing in dev — the next
        // loadBaseline tolerates orphan state (returns null, treats user as
        // first-time) so the user is never blocked.
        void wipeBaseline().catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          devWarn(`[Entros] wipeBaseline failed: ${message}`);
        });
        dispatch({ type: "resetBaseline" });
      },
      openWalletMenu: () => dispatch({ type: "setWalletMenuOpen", open: true }),
      closeWalletMenu: () => dispatch({ type: "setWalletMenuOpen", open: false }),
      setFlowIntent: (intent) => dispatch({ type: "setFlowIntent", intent }),
      setForceOutcome: (outcome) => dispatch({ type: "setForceOutcome", outcome }),
      hydrateIdentity,
    }),
    [state, connect, disconnect, hydrateIdentity],
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
};

export const useAppState = (): AppStateContextValue => {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used within AppStateProvider");
  return ctx;
};
