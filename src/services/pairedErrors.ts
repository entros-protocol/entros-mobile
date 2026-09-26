// Why a paired session ended, as the executor client reports it.

export interface PairedFailure {
  /** A server reason code, or a client code from the reason taxonomy. */
  reason?: string;
  /** The HTTP status, when a server answered. */
  status?: number;
  /** Seconds the server asked the client to wait. */
  retryAfterSec?: number;
  /** A diagnostic code for a failure no reason names. Never a value from the capture. */
  detail?: string;
}

export class PairedServiceError extends Error {
  readonly failure: PairedFailure;

  constructor(failure: PairedFailure) {
    super(failure.reason ?? failure.detail ?? `http_${failure.status ?? 0}`);
    this.name = "PairedServiceError";
    this.failure = failure;
  }
}
