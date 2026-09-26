// Error taxonomy + parser for the verify flow's on-chain submission path.
// Replaces the catch-all "generic" failure bucket with discriminated kinds
// the UI can route to per-bucket copy. Defensive about Anchor SDK error
// shape drift — the SDK has shipped at least three different error
// representations across 0.27 → 0.32, and web3.js layers another shape
// on top via SendTransactionError.
//
// Source-of-truth error catalogues:
// - protocol-core/programs/entros-anchor/src/errors.rs, as bundled in
//   ./idl/entros_anchor.json (codes 6000-6036)
// - protocol-core/programs/entros-verifier/src/errors.rs (codes 6000-6007)
// - Solana runtime: SystemProgram InsufficientFunds, BlockhashNotFound,
//   AlreadyProcessed, AccountAlreadyInitialized, AccountNotInitialized
// - MWA: src/wallet/mwa.ts typed Error classes (matched by `err.name`
//   below — see "MWA typed errors" section)
//
// Anchor numerically allocates 6000+ per program independently, so the same
// numeric code maps to different errors across entros-anchor / entros-verifier.
// The error name is unambiguous where the number is not, so the parser reads it
// first: Anchor prints it as `Error Code: <Name>`, and the parsed AnchorError
// carries it as `error.errorCode.code`. A name in the bundled entros-anchor IDL
// resolves to that program's code. Without such a name the parser falls back to
// the number, prefers the message-string match for verifier codes (their
// messages are distinctive), and reads anything else in entros-anchor's range.
// Anchor 0.32+ ships per-program errors via `error.program` on the parsed
// AnchorError, but we don't depend on that because older error paths
// (preflight RPC) drop the program field.
//
// MWA typed errors (MWAUserRejectedError, MWATimeoutError, etc) are matched
// via `err.name === "..."` rather than `instanceof` so this module stays
// dependency-free of `react-native` (importing the constructors would
// transitively pull in RN's `Linking` / `Platform` value bindings, which
// can't run under Jest's Node test environment without an RN runtime mock).
// The class constructors set `this.name` explicitly, so name-matching is
// equivalent to instanceof for these well-known classes.

import anchorIdl from "./idl/entros_anchor.json";

const MWA_ERROR_NAMES = {
  userRejected: "MWAUserRejectedError",
  timeout: "MWATimeoutError",
  notInstalled: "MWAWalletNotInstalledError",
  authorizationFailed: "MWAAuthorizationFailedError",
} as const;

const isErrorWithName = (err: unknown, name: string): boolean =>
  err instanceof Error && err.name === name;

/** Discriminated error kinds the UI routes to a FailureBucket. The mapping
 *  isn't 1:1 — multiple kinds can share a bucket (retry-now collects
 *  stale-blockhash + wallet-timeout + challenge-stale + clock-drift +
 *  network-unreachable). The parser-side enum stays granular for diagnostic
 *  logging; the bucket-side stays small for UX coherence. */
export type SubmitErrorKind =
  | "wallet-rejected" // user denied sig in approval UI; silent route to /verify/intro, NO failure screen
  | "wallet-timeout" // wallet hung past MWA's 90s underlying timeout
  | "wallet-not-installed" // ERROR_WALLET_NOT_FOUND at sign-time (rare; usually caught at connect)
  | "wallet-authorization-failed" // pre-UI rejection — cluster mismatch most common cause
  | "insufficient-funds" // SystemProgram::Custom(1); fee payer < required SOL
  | "stale-blockhash" // BlockhashNotFound; congestion-driven, recoverable
  | "anchor-already-exists" // Path A repeat for already-anchored wallet; route to reset_identity_state
  | "proof-rejected" // entros-verifier ProofVerificationFailed; circuit/key drift class
  | "commitment-binding" // entros-anchor 6010 / 6011; proof <-> on-chain mismatch
  | "receipt-rejected" // entros-anchor receipt family, see RECEIPT_ERRORS
  | "challenge-stale" // entros-verifier ChallengeExpired / AlreadyUsed / NotUsed / InvalidNonce
  | "clock-drift" // entros-anchor proof or receipt timestamp off the cluster clock, see CLOCK_ERRORS
  | "cooldown-active" // entros-anchor 6012; 7-day reset gate
  | "programming-error" // arithmetic overflow / serialization; bug class — surface "report this"
  | "network-unreachable" // RPC unreachable mid-confirm; transient
  | "generic"; // last resort

/** entros-anchor error codes by name, from the bundled IDL. */
const ANCHOR_CODES_BY_NAME: ReadonlyMap<string, number> = new Map(
  anchorIdl.errors.map((error) => [error.name, error.code]),
);

/** The codes the bundled IDL gives these entros-anchor error names. The
 *  program appends new codes and has inserted some mid-range, so the tables
 *  below hold names and never a numeric range. */
function anchorCodes(names: readonly string[]): ReadonlySet<number> {
  const codes = new Set<number>();
  for (const name of names) {
    const code = ANCHOR_CODES_BY_NAME.get(name);
    if (code !== undefined) codes.add(code);
  }
  return codes;
}

/** entros-anchor errors for a receipt the program refused. */
const RECEIPT_ERRORS = [
  "MissingValidatorReceipt",
  "ReceiptValidatorMismatch",
  "ReceiptCommitmentMismatch",
  "ReceiptWalletMismatch",
  "MalformedReceiptMessage",
  "ReceiptVersionMismatch",
  "ReceiptPurposeMismatch",
  "ReceiptProjectionVersionMismatch",
  "InvalidAssuranceTier",
];

/** entros-anchor errors for a proof or receipt whose timestamp sits outside
 *  the cluster clock's window. A fresh attempt carries fresh timestamps, so
 *  these retry rather than report a validator that rotated its key. */
const CLOCK_ERRORS = ["ProofExpired", "ProofFromFuture", "ReceiptExpired", "ReceiptFromFuture"];

const RECEIPT_CODES = anchorCodes(RECEIPT_ERRORS);
const CLOCK_CODES = anchorCodes(CLOCK_ERRORS);

export interface ParsedSubmitError {
  kind: SubmitErrorKind;
  /** Original message preserved for diagnostics + clipboard "copy error" UX. */
  raw: string;
  /** Anchor error code (typically 6000-6999) when matched; null otherwise. */
  anchorCode: number | null;
}

/** The entros-anchor code an error names, from the parsed AnchorError's
 *  `errorCode.code` or the `Error Code: <Name>` Anchor prints. Null when the
 *  error names nothing, or names an error entros-anchor does not define. */
function namedAnchorCode(err: unknown): number | null {
  if (err == null || typeof err !== "object") return null;
  const candidate = err as { error?: { errorCode?: { code?: unknown } }; message?: unknown };
  const nested = candidate.error?.errorCode?.code;
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const name =
    typeof nested === "string" ? nested : /Error\s+Code:\s*([A-Za-z0-9_]+)/.exec(message)?.[1];
  return name === undefined ? null : (ANCHOR_CODES_BY_NAME.get(name) ?? null);
}

/** Pull a numeric Anchor error code out of whatever shape the SDK threw.
 *  Tries three forms in order:
 *    1. Anchor 0.32+ AnchorError shape: `err.error.errorCode.number`
 *    2. Top-level `err.code` numeric (some SDK paths surface here)
 *    3. Message-buried "Error Number: 6010" (Anchor's default Display impl) */
function extractAnchorCode(err: unknown): number | null {
  if (err == null || typeof err !== "object") return null;
  const candidate = err as {
    code?: unknown;
    error?: { errorCode?: { number?: unknown } };
    message?: unknown;
  };

  const nestedCode = candidate.error?.errorCode?.number;
  if (typeof nestedCode === "number" && Number.isFinite(nestedCode)) return nestedCode;

  // `err.code` numeric matches some SDK paths but commonly conflicts with
  // JSON-RPC error codes (e.g. -32602 is web3.js's "invalid params"). Gate
  // to Anchor's reserved range [6000, 7000) to avoid mis-categorizing
  // RPC-side errors as Anchor errors.
  if (
    typeof candidate.code === "number" &&
    Number.isFinite(candidate.code) &&
    candidate.code >= 6000 &&
    candidate.code < 7000
  ) {
    return candidate.code;
  }

  const msg = typeof candidate.message === "string" ? candidate.message : "";

  // Anchor's Display impl: "AnchorError ... Error Code: CommitmentMismatch.
  // Error Number: 6010 ..."
  const errNumberMatch = msg.match(/Error\s+Number:\s*(\d+)/i);
  if (errNumberMatch && errNumberMatch[1]) {
    const parsed = parseInt(errNumberMatch[1], 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  // RPC-shape InstructionError JSON: `{"InstructionError":[0,{"Custom":6010}]}`.
  // Match `"Custom":N` and gate to Anchor's reserved range so SystemProgram's
  // Custom:1 (InsufficientFunds) doesn't collapse into the Anchor path.
  const customMatch = msg.match(/"Custom"\s*:\s*(\d+)/);
  if (customMatch && customMatch[1]) {
    const parsed = parseInt(customMatch[1], 10);
    if (Number.isFinite(parsed) && parsed >= 6000 && parsed < 7000) return parsed;
  }

  return null;
}

/** Categorize a confirmed-numeric Anchor code. Disambiguates entros-anchor
 *  vs entros-verifier by matching on the message string first (verifier
 *  messages are distinctive), then falling through to the entros-anchor
 *  range (since entros-anchor errors are the majority of mobile's submit
 *  catches — most calls are mintAnchor / updateAnchor / resetIdentityState). */
function categorizeAnchorCode(code: number, raw: string): ParsedSubmitError {
  // entros-verifier disambiguation by distinctive message substrings.
  // `\s*` between words handles both Anchor's PascalCase enum names
  // ("ProofVerificationFailed") and the space-separated `#[msg(...)]`
  // strings ("Proof verification failed"). Case-insensitive.
  if (
    /Proof\s*Verification\s*Failed|Invalid\s*Proof\s*Format|Invalid\s*Public\s*Inputs/i.test(raw)
  ) {
    return { kind: "proof-rejected", raw, anchorCode: code };
  }
  if (
    /Challenge\s*(?:Has\s*)?Expired|Challenge\s*Already\s*Used|Challenge\s*(?:Must\s*Be\s*Used|Not\s*Used)|Invalid\s*Nonce/i.test(
      raw,
    )
  ) {
    return { kind: "challenge-stale", raw, anchorCode: code };
  }

  // entros-anchor receipt failures.
  if (RECEIPT_CODES.has(code)) {
    return { kind: "receipt-rejected", raw, anchorCode: code };
  }

  // entros-anchor: commitment-binding mismatches
  if (code === 6010 || code === 6011) {
    return { kind: "commitment-binding", raw, anchorCode: code };
  }

  // entros-anchor: clock-drift
  if (CLOCK_CODES.has(code)) {
    return { kind: "clock-drift", raw, anchorCode: code };
  }

  // entros-anchor: cooldown
  if (code === 6012) {
    return { kind: "cooldown-active", raw, anchorCode: code };
  }

  // entros-anchor: programming-error class (arithmetic overflow / serialization)
  if (code === 6002 || code === 6005) {
    return { kind: "programming-error", raw, anchorCode: code };
  }

  // entros-anchor: every other variant we haven't carved out. Keep the code for
  // diagnostics, but route to `generic`, not `programming-error`.
  //
  // `programming-error` renders "report this", which is right for the two codes
  // carved out above and wrong for everything else. Most unmatched variants are
  // protocol state rather than bugs, and the program gains variants faster than
  // this table does: 6025 landed here and told users to file a bug report for a
  // rate limit. An unfamiliar code means this table is behind, not that the
  // program is broken.
  return { kind: "generic", raw, anchorCode: code };
}

/** Pull the most-informative message string out of any error shape.
 *  Errors come through as: native Error instances, AnchorError plain objects
 *  (`{error: {errorCode: {...}}, message: "..."}`), or string-coerced values.
 *  Falling back to `String(obj)` produces "[object Object]" for the AnchorError
 *  case, which strips the actual diagnostic — preserve `obj.message` first. */
const extractRaw = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (err != null && typeof err === "object") {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return String(err);
};

/** Convert a raw caught error into a typed ParsedSubmitError. Order matters:
 *  - MWA Error classes (instanceof) FIRST so we catch known typed errors
 *    before falling into message-regex heuristics
 *  - Anchor error name, then numeric code, SECOND because their match is
 *    most specific
 *  - SystemProgram + runtime patterns THIRD
 *  - Generic fallthrough LAST */
export function parseSubmitError(err: unknown): ParsedSubmitError {
  const raw = extractRaw(err);

  // 1. MWA typed errors (already classed at the wallet layer; matched by
  // `err.name` to avoid pulling react-native into this module — see header).
  if (isErrorWithName(err, MWA_ERROR_NAMES.userRejected)) {
    return { kind: "wallet-rejected", raw, anchorCode: null };
  }
  if (isErrorWithName(err, MWA_ERROR_NAMES.timeout)) {
    return { kind: "wallet-timeout", raw, anchorCode: null };
  }
  if (isErrorWithName(err, MWA_ERROR_NAMES.notInstalled)) {
    return { kind: "wallet-not-installed", raw, anchorCode: null };
  }
  if (isErrorWithName(err, MWA_ERROR_NAMES.authorizationFailed)) {
    return { kind: "wallet-authorization-failed", raw, anchorCode: null };
  }

  // 2. Sign-time wallet rejection via message regex (Phantom/Solflare surface
  // user-cancellation as "User rejected the request", "Transaction was denied
  // by user", "Wallet cancelled" — variable order/phrasing). We require BOTH
  // a rejection verb AND a wallet/user/approval noun to fire so unrelated
  // strings containing only one keyword don't false-positive.
  if (
    /\b(?:rejected|cancelled|canceled|denied)\b/i.test(raw) &&
    /\b(?:user|wallet|approval)\b/i.test(raw)
  ) {
    return { kind: "wallet-rejected", raw, anchorCode: null };
  }

  // Local first-verification checks run before wallet or RPC work.
  if (
    /First verification requires a validator-signed receipt|validator-signed receipt is malformed/i.test(
      raw,
    )
  ) {
    return { kind: "receipt-rejected", raw, anchorCode: null };
  }

  // 3. Anchor error path (mintAnchor / updateAnchor / verifyProof /
  // resetIdentityState all surface here on chain-side rejection). The name
  // resolves before the number, which two programs can share.
  const namedCode = namedAnchorCode(err);
  if (namedCode !== null) return categorizeAnchorCode(namedCode, raw);
  const anchorCode = extractAnchorCode(err);
  if (anchorCode !== null && anchorCode >= 6000 && anchorCode < 7000) {
    return categorizeAnchorCode(anchorCode, raw);
  }

  // 4. Anchor `init` constraint failure when the PDA already exists. Surfaces
  // as a SystemProgram allocate error — "Allocate: account Address X already
  // in use" — without an Anchor numeric code. Fires when Path A retries for
  // a wallet whose IdentityState PDA is already initialized on chain.
  if (/already\s+in\s+use|AccountAlreadyInitialized|already\s+initialized/i.test(raw)) {
    return { kind: "anchor-already-exists", raw, anchorCode: null };
  }

  // 5. SystemProgram InsufficientFunds. Surfaces in two shapes:
  //   - JSON-shape InstructionError: `{"InstructionError":[0,{"Custom":1}]}`
  //     where the field is quoted as `"Custom":1`
  //   - Plain-text Anchor display: `Custom: 1` (space-separated, no quotes)
  // Optional double-quotes around `Custom` and around the value handle both
  // forms in a single regex. The `\b` after `1` ensures we don't match
  // longer numerics (Custom:10, Custom:100, etc).
  if (
    /"?Custom"?\s*:\s*"?1"?\b|InsufficientFunds|insufficient\s+(?:lamports|funds|sol)/i.test(raw)
  ) {
    return { kind: "insufficient-funds", raw, anchorCode: null };
  }

  // 6. Stale blockhash — congestion-driven, transient. AlreadyProcessed
  // collapses here too (the duplicate signature was likely from a previous
  // tx that already landed; user retries with same blockhash).
  if (
    /BlockhashNotFound|blockhash.*not\s*found|expired\s+blockhash|AlreadyProcessed|already\s*been\s*processed/i.test(
      raw,
    )
  ) {
    return { kind: "stale-blockhash", raw, anchorCode: null };
  }

  // 7. Network unreachable. Distinguishes from MWATimeoutError (which is
  // wallet-not-responding) — this is the Solana RPC layer dying.
  if (
    /(?:^|\s)network\s+(?:request\s+)?failed|fetch\s+failed|ECONNREFUSED|ENOTFOUND|getaddrinfo|RPC\s+(?:request\s+)?failed/i.test(
      raw,
    )
  ) {
    return { kind: "network-unreachable", raw, anchorCode: null };
  }

  return { kind: "generic", raw, anchorCode: null };
}
