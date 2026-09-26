// HTTP client for paired-round sessions on the executor: open, commit and
// finalize. It uses the executor base URL and API key the single capture uses.
//
// Open retries a network error, 408, 429 and 5xx for a bounded window, and a
// commit retries them until its round expires, each honouring `retry_after`.
// A commit resends identical bytes, so the server's idempotency record
// recognises it. Finalize resends only while nothing was judged: after no
// response, a 408, or a 5xx other than `technical_failure`, until the session
// ends. The server consumes a session once, so a resend is never judged twice.
//
// PRIVACY: open and commit carry a wallet, digests and small integers. Segment
// audio and coarse paths leave the device only in the finalize body, which a
// resend repeats unchanged. This module never logs or retains a body.

import { config } from "@/config";
import { isRecord, type JsonRecord } from "@/lib/values";
import {
  commitWithRetry,
  finalizeRetryAfterMs,
  isTransientStatus,
  PairedClientError,
  parseOpenResponse,
  refusalOf,
  retryUntil,
  type PairedCommitResponse,
  type PairedFinalizeBody,
  type PairedHttpResponse,
  type PairedOpenSession,
  type PairedRoundCommit,
  type RetryClock,
} from "@/paired";

import { PairedServiceError, type PairedFailure } from "./pairedErrors";
import { isVerificationReason } from "./reasons";
import {
  postValidationJson,
  ValidationTransportError,
  type ValidationJsonResponse,
} from "./validationJsonTransport";

/** Retries of a session open stop after this long. */
const OPEN_RETRY_WINDOW_MS = 15_000;
/** One open or commit request may take this long before it is retried. */
const ROUND_REQUEST_TIMEOUT_MS = 10_000;
/** One finalize request may take this long. The session's end also bounds it. */
const FINALIZE_REQUEST_TIMEOUT_MS = 120_000;

export interface OpenedPairedSession {
  open: PairedOpenSession;
  /** The `now` clock reading when the open response arrived. Server durations count from it. */
  receivedAtMs: number;
}

export interface PairedRequestOptions {
  signal?: AbortSignal;
  /** Monotonic clock for deadlines. Defaults to `performance.now`. */
  now?: () => number;
  /** Waits between retries. Rejecting ends the retry loop. */
  sleep?: (ms: number) => Promise<void>;
}

export type PairedFinalizeOutcome =
  | {
      kind: "ok";
      /** The validator's success body, checked before any wallet prompt. */
      body: JsonRecord;
    }
  | { kind: "rejected"; failure: PairedFailure };

interface Endpoint {
  url: string;
  headers: Record<string, string>;
}

function endpoint(path: string): Endpoint {
  if (!config.relayerUrl) {
    throw new PairedServiceError({ reason: "validation_unavailable", detail: "relayer_unset" });
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (config.relayerApiKey) headers["X-API-Key"] = config.relayerApiKey;
  return { url: new URL(path, new URL(config.relayerUrl).origin).toString(), headers };
}

function abortError(): Error {
  const error = new Error("The paired request was cancelled.");
  error.name = "AbortError";
  return error;
}

/** A sleep that rejects as soon as `signal` aborts. */
function abortableSleep(signal?: AbortSignal): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function clockOf(options: PairedRequestOptions): RetryClock {
  return {
    now: options.now ?? (() => performance.now()),
    sleep: options.sleep ?? abortableSleep(options.signal),
  };
}

/** POSTs a serialized body. Throws on a network failure, a timeout or an abort. */
async function postJson(
  target: Endpoint,
  serializedBody: string,
  signal: AbortSignal | undefined,
): Promise<PairedHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROUND_REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) throw abortError();
    const response = await fetch(target.url, {
      method: "POST",
      headers: target.headers,
      body: serializedBody,
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A gateway error page is not JSON. The status still classifies it.
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** The failure a client error reports. A known reason from a bad response is kept. */
function failureOf(error: PairedClientError): PairedFailure {
  if (error.kind === "invalid_response") {
    return {
      reason: isVerificationReason(error.reason) ? error.reason : "malformed_response",
      detail: error.message,
    };
  }
  const failure: PairedFailure = { reason: error.reason };
  if (error.status !== undefined) failure.status = error.status;
  if (error.retryAfterSec !== undefined) failure.retryAfterSec = error.retryAfterSec;
  return failure;
}

/**
 * Opens a paired session and validates the first reveal. A 404 names a relayer
 * without paired sessions: the failure carries status 404 and reason
 * `unsupported_session`. Retries that run out report the last refusal.
 */
export async function openPairedSession(
  wallet: string,
  options: PairedRequestOptions = {},
): Promise<OpenedPairedSession> {
  const target = endpoint("/challenge/paired");
  const clock = clockOf(options);
  const body = JSON.stringify({ wallet, tier: "trace" });
  try {
    const response = await retryUntil<PairedHttpResponse>(
      async () => {
        let response: PairedHttpResponse;
        try {
          response = await postJson(target, body, options.signal);
        } catch (error) {
          if (options.signal?.aborted) throw error;
          return { retry: new PairedClientError("refused", "validation_unavailable") };
        }
        if (response.status >= 200 && response.status <= 299) return { value: response };
        const refusal = refusalOf(response);
        if (!isTransientStatus(response.status)) throw refusal;
        return { retry: refusal, waitMs: (refusal.retryAfterSec ?? 0) * 1_000 };
      },
      clock.now() + OPEN_RETRY_WINDOW_MS,
      clock,
    );
    return { open: parseOpenResponse(response.body), receivedAtMs: clock.now() };
  } catch (error) {
    if (error instanceof PairedClientError) throw new PairedServiceError(failureOf(error));
    throw error;
  }
}

/**
 * Commits one round, retrying until `deadlineMs` on the `now` clock. Resolves
 * with the validated response, which carries the next reveal while the session
 * still awaits a commit.
 */
export async function commitPairedRound(
  commit: PairedRoundCommit,
  deadlineMs: number,
  options: PairedRequestOptions = {},
): Promise<PairedCommitResponse> {
  const target = endpoint("/paired/commit");
  try {
    return await commitWithRetry(
      (serialized) => postJson(target, serialized, options.signal),
      commit,
      { deadlineMs, ...clockOf(options) },
    );
  } catch (error) {
    if (error instanceof PairedClientError) throw new PairedServiceError(failureOf(error));
    throw error;
  }
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // A gateway error page is not JSON. The status still classifies it.
    return null;
  }
}

/** The failure a finalize response carries once no resend is left. */
function finalizeFailure(response: PairedHttpResponse): PairedFailure {
  const body = isRecord(response.body) ? response.body : {};
  const reason = typeof body.reason === "string" && body.reason ? body.reason : undefined;
  const retryAfterSec =
    typeof body.retry_after === "number" &&
    Number.isFinite(body.retry_after) &&
    body.retry_after > 0
      ? body.retry_after
      : undefined;
  const failure: PairedFailure = { status: response.status };
  if (response.status === 0) failure.reason = "validation_unavailable";
  else if (response.status === 408) failure.reason = "validation_timeout";
  else if (response.status === 413) failure.reason = "payload_too_large";
  else if (response.status === 429) failure.reason = reason ?? "rate_limited";
  else if (response.status >= 500) {
    // A session that faulted after the server consumed it says so, because the
    // next attempt must open a new session rather than resend.
    failure.reason = reason === "technical_failure" ? reason : "validation_unavailable";
  } else if (reason !== undefined) failure.reason = reason;
  if (retryAfterSec !== undefined && response.status < 500) failure.retryAfterSec = retryAfterSec;
  return failure;
}

function transportFailure(error: unknown): PairedFailure {
  return error instanceof ValidationTransportError && error.kind === "network"
    ? { reason: "validation_unavailable" }
    : { reason: "validation_timeout" };
}

/**
 * Sends the finalize request, and sends it again while nothing was judged and
 * the session has room. Always resolves: a rejection carries the reason the
 * executor gave, or a client reason when no server answered. A finalize whose
 * session has already ended is never sent.
 */
export async function finalizePairedSession(
  body: PairedFinalizeBody,
  options: PairedRequestOptions & { sessionEndsAtMs: number },
): Promise<PairedFinalizeOutcome> {
  const { now, sleep } = clockOf(options);
  const { sessionEndsAtMs, signal } = options;
  if (now() >= sessionEndsAtMs) {
    return { kind: "rejected", failure: { reason: "session_expired" } };
  }
  let target: Endpoint;
  try {
    target = endpoint("/validate-session");
  } catch (error) {
    if (error instanceof PairedServiceError) return { kind: "rejected", failure: error.failure };
    throw error;
  }
  const serialized = JSON.stringify(body);

  for (let attempt = 0; ; attempt++) {
    let response: PairedHttpResponse | null = null;
    let transportError: unknown = null;
    try {
      const sent: ValidationJsonResponse = await postValidationJson({
        url: target.url,
        headers: target.headers,
        body: serialized,
        deadlineAtMs: Math.min(now() + FINALIZE_REQUEST_TIMEOUT_MS, sessionEndsAtMs),
        signal,
      });
      response = { status: sent.status, body: parseBody(sent.body) };
    } catch (error) {
      transportError = error;
    }
    if (response && response.status >= 200 && response.status <= 299) {
      return isRecord(response.body) && response.body.valid === true
        ? { kind: "ok", body: response.body }
        : { kind: "rejected", failure: { reason: "malformed_response", status: response.status } };
    }
    const failure = response ? finalizeFailure(response) : transportFailure(transportError);
    const wait = signal?.aborted ? null : finalizeRetryAfterMs(response, attempt);
    if (wait === null || now() + wait >= sessionEndsAtMs) return { kind: "rejected", failure };
    try {
      await sleep(wait);
    } catch {
      return { kind: "rejected", failure };
    }
  }
}
