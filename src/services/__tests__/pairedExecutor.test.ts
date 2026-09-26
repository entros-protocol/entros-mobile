import { bytesToHex } from "@noble/hashes/utils.js";

import { accept, acceptJson, openJson, WALLET } from "@/flows/__tests__/pairedFixtures";
import {
  buildCommitBody,
  initialCommitment,
  parseOpenResponse,
  type PairedFinalizeBody,
  type PairedRoundCommit,
} from "@/paired";
import { bytes, traceSession } from "@/paired/__tests__/vectors";

import { PairedServiceError } from "../pairedErrors";
import { commitPairedRound, finalizePairedSession, openPairedSession } from "../pairedExecutor";
import { postValidationJson, ValidationTransportError } from "../validationJsonTransport";

jest.mock("@/config", () => ({
  config: { relayerUrl: "https://executor.test/base", relayerApiKey: "integrator-key" },
}));
jest.mock("../validationJsonTransport", () => {
  const actual = jest.requireActual("../validationJsonTransport");
  return { ...actual, postValidationJson: jest.fn() };
});

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;
const postMock = jest.mocked(postValidationJson);

function respond(status: number, body: unknown): void {
  fetchMock.mockResolvedValueOnce({
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError("not json");
      return body;
    },
  });
}

function clock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

function roundOne(): PairedRoundCommit {
  const open = parseOpenResponse(openJson());
  const round = traceSession().roundEntries[0]!;
  return buildCommitBody({
    open,
    reveal: open.reveal,
    walletId: WALLET,
    previousCommitment: initialCommitment(open),
    segment: bytes(round.audioSegmentHex),
    coarsePath: bytes(round.coarsePathHex),
    pointCount: round.pathPointCount,
    idempotencyKey: new Uint8Array(16).fill(4),
  });
}

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PairedServiceError) return error.failure;
    throw error;
  }
  throw new Error("Expected a paired service error.");
}

beforeEach(() => {
  fetchMock.mockReset();
  postMock.mockReset();
});

describe("open", () => {
  test("posts the wallet and tier to the executor origin with the API key", async () => {
    respond(200, openJson());
    const time = clock();
    const opened = await openPairedSession(WALLET, time);
    expect(opened.open.sessionId).toBe(openJson().session_id);
    expect(opened.receivedAtMs).toBe(0);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://executor.test/challenge/paired");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ wallet: WALLET, tier: "trace" });
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-API-Key": "integrator-key",
    });
  });

  test("retries a validator outage and a network error, then opens", async () => {
    respond(503, { error: "down", reason: "validation_unavailable" });
    fetchMock.mockRejectedValueOnce(new TypeError("Network request failed"));
    respond(200, openJson());
    const time = clock();
    await expect(openPairedSession(WALLET, time)).resolves.toBeDefined();
    expect(time.sleeps).toEqual([250, 500]);
  });

  test("gives up after the retry window with the last reason", async () => {
    for (let attempt = 0; attempt < 20; attempt++)
      respond(503, { reason: "validation_unavailable" });
    const time = clock();
    expect(await failureOf(openPairedSession(WALLET, time))).toEqual({
      reason: "validation_unavailable",
      status: 503,
    });
  });

  test("retries a 429 whose wait fits the window", async () => {
    respond(429, { reason: "capacity_reached", retry_after: 1 });
    respond(200, openJson());
    const time = clock();
    await expect(openPairedSession(WALLET, time)).resolves.toBeDefined();
    expect(time.sleeps).toEqual([1_000]);
  });

  test("names a relayer without paired sessions by its 404", async () => {
    respond(404, undefined);
    const time = clock();
    expect(await failureOf(openPairedSession(WALLET, time))).toEqual({
      reason: "unsupported_session",
      status: 404,
    });
    expect(time.sleeps).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("ends at once on a spent budget, carrying the server's wait", async () => {
    respond(429, { error: "busy", reason: "session_budget_exhausted", retry_after: 30 });
    const time = clock();
    expect(await failureOf(openPairedSession(WALLET, time))).toEqual({
      reason: "session_budget_exhausted",
      status: 429,
      retryAfterSec: 30,
    });
    expect(time.sleeps).toEqual([]);
  });

  test("ends on a state conflict and refuses another protocol or a bad reveal", async () => {
    respond(409, { reason: "finalize_in_progress" });
    expect(await failureOf(openPairedSession(WALLET, clock()))).toEqual({
      reason: "finalize_in_progress",
      status: 409,
    });
    respond(200, openJson({ protocol_version: 2 }));
    expect((await failureOf(openPairedSession(WALLET, clock()))).reason).toBe(
      "unsupported_session",
    );
    respond(200, openJson({ session_id: "not-a-session" }));
    expect((await failureOf(openPairedSession(WALLET, clock()))).reason).toBe("malformed_response");
    const reveal = openJson().reveal as Record<string, unknown>;
    respond(200, openJson({ reveal: { ...reveal, challenge_digest: "00".repeat(32) } }));
    expect((await failureOf(openPairedSession(WALLET, clock()))).reason).toBe("challenge_mismatch");
  });
});

describe("commit", () => {
  test("posts the commit body unchanged and returns the next reveal", async () => {
    const commit = roundOne();
    respond(200, acceptJson(commit));
    const response = await commitPairedRound(commit, 60_000, clock());
    expect(response.reveal?.roundIndex).toBe(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://executor.test/paired/commit");
    expect(init.body).toBe(JSON.stringify(commit.body));
    expect(bytesToHex(response.commitment)).toBe(commit.body.commitment);
  });

  test("resends identical bytes after a 429 and a 503", async () => {
    const commit = roundOne();
    respond(429, { reason: "capacity_reached", retry_after: 1 });
    respond(503, {});
    respond(200, acceptJson(commit));
    const time = clock();
    await commitPairedRound(commit, 60_000, time);
    const bodies = fetchMock.mock.calls.map(([, init]) => init.body);
    expect(new Set(bodies).size).toBe(1);
    expect(time.sleeps).toEqual([1_000, 500]);
  });

  test("maps a terminal rejection, spent retries and a mismatched answer", async () => {
    const commit = roundOne();
    respond(409, { reason: "session_superseded" });
    expect(await failureOf(commitPairedRound(commit, 60_000, clock()))).toEqual({
      reason: "session_superseded",
      status: 409,
    });

    fetchMock.mockRejectedValue(new TypeError("Network request failed"));
    expect(await failureOf(commitPairedRound(commit, 2_000, clock()))).toEqual({
      reason: "validation_unavailable",
    });
    fetchMock.mockReset();

    // Retries that run out report the service as unavailable, not the last busy answer.
    for (let attempt = 0; attempt < 10; attempt++) respond(429, { reason: "capacity_reached" });
    expect(await failureOf(commitPairedRound(commit, 2_000, clock()))).toEqual({
      reason: "validation_unavailable",
      status: 429,
    });

    respond(200, { ...acceptJson(commit), commitment: "00".repeat(32) });
    expect((await failureOf(commitPairedRound(commit, 60_000, clock()))).reason).toBe(
      "commitment_mismatch",
    );
  });

  test("reports an expired round without sending the commit", async () => {
    const time = clock();
    expect(await failureOf(commitPairedRound(roundOne(), 0, time))).toEqual({
      reason: "round_expired",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("stops retrying when the caller aborts", async () => {
    const commit = roundOne();
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      controller.abort();
      throw new TypeError("Network request failed");
    });
    await expect(
      commitPairedRound(commit, 60_000, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockReset();
  });

  test("accept() in the fixtures agrees with the client parser", () => {
    const commit = roundOne();
    expect(accept(commit).acceptedRound).toBe(1);
  });
});

describe("finalize", () => {
  const body = { capture_protocol: "paired" } as unknown as PairedFinalizeBody;

  function reply(status: number, response: unknown) {
    postMock.mockResolvedValueOnce({
      status,
      body: response === undefined ? "<html>gateway</html>" : JSON.stringify(response),
    });
  }

  /** A clock whose session ends before any resend fits, so one answer decides. */
  const once = () => ({ ...clock(), sessionEndsAtMs: 200 });

  test("posts to /validate-session and returns the success body", async () => {
    const success = { valid: true, remaining_quota: 9, assurance_tier: 2 };
    reply(200, success);
    const outcome = await finalizePairedSession(body, { ...clock(), sessionEndsAtMs: 5_000 });
    expect(outcome).toEqual({ kind: "ok", body: success });
    const [request] = postMock.mock.calls[0]!;
    expect(request.url).toBe("https://executor.test/validate-session");
    expect(request.body).toBe(JSON.stringify(body));
    expect(request.deadlineAtMs).toBe(5_000);
  });

  test("refuses a success body that does not say it is valid", async () => {
    reply(200, { valid: false });
    await expect(finalizePairedSession(body, once())).resolves.toEqual({
      kind: "rejected",
      failure: { reason: "malformed_response", status: 200 },
    });
  });

  test.each([
    [
      400,
      { reason: "phrase_content_mismatch" },
      { reason: "phrase_content_mismatch", status: 400 },
    ],
    [400, { reason: "trace_incomplete" }, { reason: "trace_incomplete", status: 400 }],
    [400, { error: "Verification failed" }, { status: 400 }],
    [409, { reason: "session_consumed" }, { reason: "session_consumed", status: 409 }],
    [
      429,
      { reason: "rate_limited", retry_after: 12 },
      { reason: "rate_limited", status: 429, retryAfterSec: 12 },
    ],
    [503, { reason: "technical_failure" }, { reason: "technical_failure", status: 503 }],
    [503, { reason: "session_busy" }, { reason: "validation_unavailable", status: 503 }],
    [502, undefined, { reason: "validation_unavailable", status: 502 }],
    [408, undefined, { reason: "validation_timeout", status: 408 }],
    [413, undefined, { reason: "payload_too_large", status: 413 }],
    [401, { error: "Unauthorized" }, { status: 401 }],
  ] as const)("maps HTTP %i to its failure", async (status, response, failure) => {
    reply(status, response);
    await expect(finalizePairedSession(body, once())).resolves.toEqual({
      kind: "rejected",
      failure,
    });
  });

  test("maps transport failures to client reasons", async () => {
    postMock.mockRejectedValueOnce(new ValidationTransportError("network", "offline"));
    await expect(finalizePairedSession(body, once())).resolves.toEqual({
      kind: "rejected",
      failure: { reason: "validation_unavailable" },
    });
    postMock.mockRejectedValueOnce(new ValidationTransportError("stalled", "stalled"));
    await expect(finalizePairedSession(body, once())).resolves.toEqual({
      kind: "rejected",
      failure: { reason: "validation_timeout" },
    });
  });

  test("resends the same body to a busy relayer, honouring its wait", async () => {
    reply(503, { reason: "session_busy", retry_after: 1 });
    reply(200, { valid: true });
    const time = clock();
    const outcome = await finalizePairedSession(body, { ...time, sessionEndsAtMs: 60_000 });
    expect(outcome).toEqual({ kind: "ok", body: { valid: true } });
    expect(time.sleeps).toEqual([1_000]);
    const bodies = postMock.mock.calls.map(([request]) => request.body);
    expect(bodies).toEqual([JSON.stringify(body), JSON.stringify(body)]);
  });

  test("resends after no response and after a 408", async () => {
    postMock.mockRejectedValueOnce(new ValidationTransportError("network", "offline"));
    reply(408, undefined);
    reply(400, { reason: "trace_incomplete" });
    const time = clock();
    const outcome = await finalizePairedSession(body, { ...time, sessionEndsAtMs: 60_000 });
    expect(outcome).toEqual({
      kind: "rejected",
      failure: { reason: "trace_incomplete", status: 400 },
    });
    expect(time.sleeps).toEqual([250, 500]);
    expect(postMock).toHaveBeenCalledTimes(3);
  });

  test.each([
    [503, { reason: "technical_failure" }],
    [400, { reason: "phrase_content_mismatch" }],
    [409, { reason: "session_consumed" }],
    [429, { reason: "rate_limited", retry_after: 1 }],
  ] as const)("never resends after HTTP %i", async (status, response) => {
    reply(status, response);
    await finalizePairedSession(body, { ...clock(), sessionEndsAtMs: 60_000 });
    expect(postMock).toHaveBeenCalledTimes(1);
  });

  test("stops resending when the next attempt would pass the session's end", async () => {
    postMock.mockRejectedValue(new ValidationTransportError("network", "offline"));
    const time = clock();
    const outcome = await finalizePairedSession(body, { ...time, sessionEndsAtMs: 1_000 });
    expect(outcome).toEqual({ kind: "rejected", failure: { reason: "validation_unavailable" } });
    // Sends at 0, 250 and 750. The next wait would end at 1,750.
    expect(time.sleeps).toEqual([250, 500]);
    expect(postMock).toHaveBeenCalledTimes(3);
  });

  test("reports an expired session without sending", async () => {
    await expect(finalizePairedSession(body, { ...clock(), sessionEndsAtMs: 0 })).resolves.toEqual({
      kind: "rejected",
      failure: { reason: "session_expired" },
    });
    expect(postMock).not.toHaveBeenCalled();
  });

  test("stops resending once the caller aborts", async () => {
    const controller = new AbortController();
    postMock.mockImplementation(async () => {
      controller.abort();
      throw new ValidationTransportError("aborted", "aborted");
    });
    await finalizePairedSession(body, {
      ...clock(),
      sessionEndsAtMs: 60_000,
      signal: controller.signal,
    });
    expect(postMock).toHaveBeenCalledTimes(1);
  });
});
