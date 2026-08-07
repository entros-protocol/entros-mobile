// Unit tests for parseSubmitError. Covers each SubmitErrorKind path with
// synthetic error shapes mirroring what the Anchor SDK + web3.js + MWA
// layer actually emit. Runs in pure Node — no fixture-loading, no mocked
// React Native runtime.
//
// MWA-typed errors are constructed via `nameError(name, message)` rather
// than importing the actual classes from `@/wallet/mwa` — that module
// transitively imports react-native, which can't be loaded under Jest's
// Node environment without an RN runtime mock. The parser matches by
// `err.name`, so this is byte-equivalent to constructing the real classes.

import { parseSubmitError } from "../errors";

/** Build an Error whose `.name` matches one of the MWA class names. The
 *  parser uses `err.name === "..."` rather than `instanceof`, so this is
 *  equivalent to constructing the real `MWAUserRejectedError` / etc. */
const nameError = (name: string, message: string): Error => {
  const err = new Error(message);
  err.name = name;
  return err;
};

describe("parseSubmitError — MWA typed errors (name-matched)", () => {
  test("MWAUserRejectedError → wallet-rejected", () => {
    const out = parseSubmitError(
      nameError("MWAUserRejectedError", "Wallet connection was cancelled."),
    );
    expect(out.kind).toBe("wallet-rejected");
    expect(out.anchorCode).toBeNull();
  });

  test("MWATimeoutError → wallet-timeout", () => {
    const out = parseSubmitError(nameError("MWATimeoutError", "Phantom did not respond in time."));
    expect(out.kind).toBe("wallet-timeout");
  });

  test("MWAWalletNotInstalledError → wallet-not-installed", () => {
    const out = parseSubmitError(
      nameError("MWAWalletNotInstalledError", "Solflare is not installed on this device."),
    );
    expect(out.kind).toBe("wallet-not-installed");
  });

  test("MWAAuthorizationFailedError → wallet-authorization-failed", () => {
    const out = parseSubmitError(
      nameError(
        "MWAAuthorizationFailedError",
        "Wallet rejected the connection before showing approval.",
      ),
    );
    expect(out.kind).toBe("wallet-authorization-failed");
  });
});

describe("parseSubmitError — sign-time wallet rejection via message", () => {
  test("'User rejected the request' → wallet-rejected", () => {
    const out = parseSubmitError(new Error("User rejected the request"));
    expect(out.kind).toBe("wallet-rejected");
  });

  test("'Wallet cancelled the operation' → wallet-rejected", () => {
    const out = parseSubmitError(new Error("Wallet cancelled the operation"));
    expect(out.kind).toBe("wallet-rejected");
  });

  test("'Transaction was denied by user' → wallet-rejected", () => {
    const out = parseSubmitError(new Error("Transaction was denied by user"));
    expect(out.kind).toBe("wallet-rejected");
  });
});

describe("parseSubmitError - local receipt validation", () => {
  test("missing receipt maps to receipt-rejected", () => {
    const out = parseSubmitError(
      new Error("First verification requires a validator-signed receipt."),
    );
    expect(out.kind).toBe("receipt-rejected");
  });

  test("malformed receipt maps to receipt-rejected", () => {
    const out = parseSubmitError(new Error("The validator-signed receipt is malformed."));
    expect(out.kind).toBe("receipt-rejected");
  });
});

describe("parseSubmitError — Anchor numeric codes", () => {
  test("AnchorError shape with errorCode.number=6010 → commitment-binding", () => {
    const err = {
      message: "AnchorError occurred. Error Code: CommitmentMismatch. Error Number: 6010.",
      error: { errorCode: { number: 6010, code: "CommitmentMismatch" } },
    };
    const out = parseSubmitError(err);
    expect(out.kind).toBe("commitment-binding");
    expect(out.anchorCode).toBe(6010);
  });

  test("PrevCommitmentMismatch (6011) → commitment-binding", () => {
    const err = { error: { errorCode: { number: 6011 } }, message: "Error Number: 6011" };
    expect(parseSubmitError(err).kind).toBe("commitment-binding");
  });

  test("ProofExpired (6009) → clock-drift", () => {
    const err = { message: "Error Number: 6009. ProofExpired" };
    expect(parseSubmitError(err).kind).toBe("clock-drift");
  });

  test("ProofFromFuture (6014) → clock-drift", () => {
    const err = { message: "Error Number: 6014. ProofFromFuture" };
    expect(parseSubmitError(err).kind).toBe("clock-drift");
  });

  test("ResetCooldownActive (6012) → cooldown-active", () => {
    const err = { message: "Error Number: 6012. ResetCooldownActive" };
    expect(parseSubmitError(err).kind).toBe("cooldown-active");
  });

  test("MissingValidatorReceipt (6015) → receipt-rejected", () => {
    const err = { message: "Error Number: 6015. MissingValidatorReceipt" };
    expect(parseSubmitError(err).kind).toBe("receipt-rejected");
    expect(parseSubmitError(err).anchorCode).toBe(6015);
  });

  test("ReceiptValidatorMismatch (6016) → receipt-rejected", () => {
    expect(parseSubmitError({ message: "Error Number: 6016" }).kind).toBe("receipt-rejected");
  });

  test("ReceiptCommitmentMismatch (6017) → receipt-rejected", () => {
    expect(parseSubmitError({ message: "Error Number: 6017" }).kind).toBe("receipt-rejected");
  });

  test("ReceiptExpired (6019) → receipt-rejected", () => {
    expect(parseSubmitError({ message: "Error Number: 6019" }).kind).toBe("receipt-rejected");
  });

  test("ReceiptFromFuture (6020) → receipt-rejected", () => {
    expect(parseSubmitError({ message: "Error Number: 6020" }).kind).toBe("receipt-rejected");
  });

  test("MalformedReceiptMessage (6021) → receipt-rejected", () => {
    expect(parseSubmitError({ message: "Error Number: 6021" }).kind).toBe("receipt-rejected");
  });

  test("an unmatched anchor code is generic, not a bug report", () => {
    // The table lags the program, and an unfamiliar code means this file is
    // behind rather than that the program is broken. 6025 sat here and told
    // users to report a rate limit as a bug.
    const parsed = parseSubmitError({ message: "Error Number: 6025" });
    expect(parsed.kind).toBe("generic");
    expect(parsed.anchorCode).toBe(6025);
  });

  test("ArithmeticOverflow (6002) → programming-error", () => {
    expect(parseSubmitError({ message: "Error Number: 6002" }).kind).toBe("programming-error");
  });
});

describe("parseSubmitError — entros-verifier message-string disambiguation", () => {
  test("ProofVerificationFailed → proof-rejected", () => {
    const err = {
      message: "AnchorError. Error Code: ProofVerificationFailed. Error Number: 6001.",
    };
    const out = parseSubmitError(err);
    expect(out.kind).toBe("proof-rejected");
    expect(out.anchorCode).toBe(6001);
  });

  test("ChallengeExpired → challenge-stale", () => {
    const err = {
      message: "Error Code: ChallengeExpired. Error Number: 6002. Challenge has expired.",
    };
    expect(parseSubmitError(err).kind).toBe("challenge-stale");
  });

  test("ChallengeAlreadyUsed → challenge-stale", () => {
    const err = { message: "Error Code: ChallengeAlreadyUsed. Error Number: 6003." };
    expect(parseSubmitError(err).kind).toBe("challenge-stale");
  });

  test("InvalidNonce → challenge-stale", () => {
    const err = { message: "Error Code: InvalidNonce. Error Number: 6006." };
    expect(parseSubmitError(err).kind).toBe("challenge-stale");
  });
});

describe("parseSubmitError — RPC-shape InstructionError JSON", () => {
  test('\'{"InstructionError":[0,{"Custom":6010}]}\' → commitment-binding', () => {
    const err = new Error(`Transaction failed on chain: {"InstructionError":[0,{"Custom":6010}]}`);
    const out = parseSubmitError(err);
    expect(out.kind).toBe("commitment-binding");
    expect(out.anchorCode).toBe(6010);
  });

  test("InstructionError Custom=6015 → receipt-rejected", () => {
    const err = new Error(`{"InstructionError":[1,{"Custom":6015}]}`);
    expect(parseSubmitError(err).kind).toBe("receipt-rejected");
  });

  test("InstructionError Custom=1 (SystemProgram InsufficientFunds) → insufficient-funds", () => {
    const err = new Error(`Transaction failed on chain: {"InstructionError":[0,{"Custom":1}]}`);
    expect(parseSubmitError(err).kind).toBe("insufficient-funds");
  });

  test("InstructionError Custom=5999 (just below Anchor range) → does NOT match Anchor; falls to generic", () => {
    const err = new Error(`{"InstructionError":[0,{"Custom":5999}]}`);
    expect(parseSubmitError(err).kind).toBe("generic");
  });
});

describe("parseSubmitError — runtime errors", () => {
  test("BlockhashNotFound → stale-blockhash", () => {
    expect(parseSubmitError(new Error("BlockhashNotFound")).kind).toBe("stale-blockhash");
  });

  test("'blockhash not found' (sentence form) → stale-blockhash", () => {
    expect(parseSubmitError(new Error("Recent blockhash not found")).kind).toBe("stale-blockhash");
  });

  test("AlreadyProcessed → stale-blockhash (treated as transient retry)", () => {
    expect(parseSubmitError(new Error("AlreadyProcessed")).kind).toBe("stale-blockhash");
  });

  test("'Transaction has already been processed' → stale-blockhash", () => {
    expect(parseSubmitError(new Error("Transaction has already been processed")).kind).toBe(
      "stale-blockhash",
    );
  });

  test("'AccountAlreadyInitialized' → anchor-already-exists", () => {
    expect(parseSubmitError(new Error("AccountAlreadyInitialized")).kind).toBe(
      "anchor-already-exists",
    );
  });

  test("'Allocate: account Address ... already in use' → anchor-already-exists", () => {
    const err = new Error("Allocate: account Address { ... } already in use");
    expect(parseSubmitError(err).kind).toBe("anchor-already-exists");
  });

  test("'fetch failed' → network-unreachable", () => {
    expect(parseSubmitError(new Error("fetch failed")).kind).toBe("network-unreachable");
  });

  test("'ECONNREFUSED 127.0.0.1:8899' → network-unreachable", () => {
    expect(parseSubmitError(new Error("connect ECONNREFUSED 127.0.0.1:8899")).kind).toBe(
      "network-unreachable",
    );
  });
});

describe("parseSubmitError — fallthrough", () => {
  test("Unknown Error message → generic", () => {
    expect(parseSubmitError(new Error("Something unexpected")).kind).toBe("generic");
  });

  test("Plain string → generic with raw preserved", () => {
    const out = parseSubmitError("an unexpected string");
    expect(out.kind).toBe("generic");
    expect(out.raw).toBe("an unexpected string");
  });

  test("null → generic", () => {
    expect(parseSubmitError(null).kind).toBe("generic");
  });

  test("undefined → generic", () => {
    expect(parseSubmitError(undefined).kind).toBe("generic");
  });

  test("Anchor code outside reserved range (5999) → does NOT match Anchor; falls to generic", () => {
    const err = { error: { errorCode: { number: 5999 } }, message: "Error Number: 5999" };
    // The 5999 inside .error.errorCode.number IS extracted (not range-gated
    // there because it's the most-trusted form), but the parseSubmitError
    // outer gate `>= 6000 && < 7000` rejects it.
    const out = parseSubmitError(err);
    expect(out.kind).toBe("generic");
  });

  test("err.code numeric outside Anchor range is ignored (e.g. JSON-RPC -32602)", () => {
    const err = { code: -32602, message: "Invalid params" };
    expect(parseSubmitError(err).kind).toBe("generic");
  });
});

describe("parseSubmitError — raw preservation", () => {
  test("raw field always reflects the original message verbatim", () => {
    const long =
      "AnchorError occurred. Error Code: CommitmentMismatch. Error Number: 6010. Some additional debug info.";
    const out = parseSubmitError(new Error(long));
    expect(out.raw).toBe(long);
    expect(out.kind).toBe("commitment-binding");
  });
});
