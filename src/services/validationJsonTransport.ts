export const VALIDATION_UPLOAD_STALL_TIMEOUT_MS = 20_000;
export const VALIDATION_DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
export const VALIDATION_CHALLENGE_MARGIN_MS = 1_000;

export type ValidationTransportFailureKind = "stalled" | "deadline" | "aborted" | "network";

export class ValidationTransportError extends Error {
  constructor(
    public readonly kind: ValidationTransportFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "ValidationTransportError";
  }
}

export interface ValidationUploadProgress {
  loaded: number;
  total: number | null;
}

export interface ValidationJsonResponse {
  status: number;
  body: string;
}

export interface ValidationJsonPostOptions {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
  deadlineAtMs?: number;
  signal?: AbortSignal;
  onUploadProgress?: (progress: ValidationUploadProgress) => void;
}

function failure(kind: ValidationTransportFailureKind, message: string): ValidationTransportError {
  return new ValidationTransportError(kind, message);
}

export function postValidationJson({
  url,
  headers,
  body,
  deadlineAtMs,
  signal,
  onUploadProgress,
}: ValidationJsonPostOptions): Promise<ValidationJsonResponse> {
  if (signal?.aborted) {
    return Promise.reject(failure("aborted", "Validation request was aborted"));
  }

  const totalTimeoutMs =
    deadlineAtMs === undefined
      ? VALIDATION_DEFAULT_TOTAL_TIMEOUT_MS
      : deadlineAtMs - performance.now() - VALIDATION_CHALLENGE_MARGIN_MS;
  if (totalTimeoutMs <= 0) {
    return Promise.reject(failure("deadline", "Validation challenge deadline expired"));
  }

  return new Promise((resolve, reject) => {
    let request: XMLHttpRequest;
    try {
      request = new XMLHttpRequest();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reject(failure("network", message));
      return;
    }
    let settled = false;
    let lastUploadedBytes = -1;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let totalTimer: ReturnType<typeof setTimeout> | undefined;

    const clearStallTimer = () => {
      if (stallTimer !== undefined) {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      }
    };

    const cleanup = () => {
      clearStallTimer();
      if (totalTimer !== undefined) {
        clearTimeout(totalTimer);
        totalTimer = undefined;
      }
      request.upload.removeEventListener("progress", handleProgress);
      request.upload.removeEventListener("load", handleUploadComplete);
      request.removeEventListener("load", handleLoad);
      request.removeEventListener("error", handleNetworkError);
      request.removeEventListener("abort", handleRequestAbort);
      signal?.removeEventListener("abort", handleCallerAbort);
    };

    const finish = (response: ValidationJsonResponse) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };

    const fail = (error: ValidationTransportError, abortRequest: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (abortRequest) {
        try {
          request.abort();
        } catch {
          // The transport error remains the request outcome.
        }
      }
      reject(error);
    };

    const armStallTimer = () => {
      clearStallTimer();
      stallTimer = setTimeout(() => {
        fail(failure("stalled", "Validation upload stopped making progress"), true);
      }, VALIDATION_UPLOAD_STALL_TIMEOUT_MS);
    };

    function handleProgress(event: ProgressEvent<EventTarget>) {
      // Native HTTP retries can restart the count. Any changed count is progress.
      if (event.loaded === lastUploadedBytes) return;
      lastUploadedBytes = event.loaded;
      if (event.lengthComputable && event.total > 0 && event.loaded >= event.total) {
        clearStallTimer();
      } else {
        armStallTimer();
      }
      try {
        onUploadProgress?.({
          loaded: event.loaded,
          total: event.lengthComputable ? event.total : null,
        });
      } catch {
        // A progress observer cannot change the request outcome.
      }
    }

    function handleUploadComplete() {
      clearStallTimer();
    }

    function handleLoad() {
      finish({ status: request.status, body: request.responseText });
    }

    function handleNetworkError() {
      fail(failure("network", "Validation request failed"), false);
    }

    function handleRequestAbort() {
      fail(failure("aborted", "Validation request was aborted"), false);
    }

    function handleCallerAbort() {
      fail(failure("aborted", "Validation request was aborted"), true);
    }

    request.upload.addEventListener("progress", handleProgress);
    request.upload.addEventListener("load", handleUploadComplete);
    request.addEventListener("load", handleLoad);
    request.addEventListener("error", handleNetworkError);
    request.addEventListener("abort", handleRequestAbort);
    signal?.addEventListener("abort", handleCallerAbort, { once: true });

    totalTimer = setTimeout(() => {
      fail(failure("deadline", "Validation request deadline expired"), true);
    }, totalTimeoutMs);
    armStallTimer();

    try {
      request.open("POST", url, true);
      for (const [name, value] of Object.entries(headers)) {
        request.setRequestHeader(name, value);
      }
      request.send(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(failure("network", message), true);
    }
  });
}
