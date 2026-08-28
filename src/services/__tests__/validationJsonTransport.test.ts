import {
  postValidationJson,
  VALIDATION_DEFAULT_TOTAL_TIMEOUT_MS,
  VALIDATION_UPLOAD_STALL_TIMEOUT_MS,
  type ValidationTransportError,
} from "../validationJsonTransport";

type Listener = EventListenerOrEventListenerObject;

class MockEventTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener | null): void {
    if (!listener) return;
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener | null): void {
    if (!listener) return;
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === "function") listener.call(this, event);
      else listener.handleEvent(event);
    }
  }

  get listenerCount(): number {
    let count = 0;
    for (const listeners of this.listeners.values()) count += listeners.size;
    return count;
  }
}

class MockXMLHttpRequest extends MockEventTarget {
  static instances: MockXMLHttpRequest[] = [];
  static configureNext: ((request: MockXMLHttpRequest) => void) | undefined;
  static constructError: Error | undefined;

  readonly uploadTarget = new MockEventTarget();
  readonly upload = this.uploadTarget as unknown as XMLHttpRequestUpload;
  readonly headers: Record<string, string> = {};
  status = 0;
  responseText = "";
  method = "";
  url = "";
  async = false;
  sentBody: string | null = null;
  abortCalls = 0;
  sendError: Error | undefined;
  onSend: (() => void) | undefined;

  constructor() {
    super();
    if (MockXMLHttpRequest.constructError) throw MockXMLHttpRequest.constructError;
    MockXMLHttpRequest.instances.push(this);
    MockXMLHttpRequest.configureNext?.(this);
    MockXMLHttpRequest.configureNext = undefined;
  }

  open(method: string, url: string, async: boolean): void {
    this.method = method;
    this.url = url;
    this.async = async;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name] = value;
  }

  send(body: string): void {
    if (this.sendError) throw this.sendError;
    this.sentBody = body;
    this.onSend?.();
  }

  abort(): void {
    this.abortCalls += 1;
    this.dispatch("abort", new Event("abort"));
  }

  progress(loaded: number, total?: number): void {
    this.uploadTarget.dispatch("progress", {
      loaded,
      total: total ?? 0,
      lengthComputable: total !== undefined,
    } as ProgressEvent);
  }

  completeUpload(): void {
    this.uploadTarget.dispatch("load", new Event("load"));
  }

  respond(status: number, body: string): void {
    this.status = status;
    this.responseText = body;
    this.dispatch("load", new Event("load"));
  }

  failNetwork(): void {
    this.dispatch("error", new Event("error"));
  }

  get listenerCountIncludingUpload(): number {
    return this.listenerCount + this.uploadTarget.listenerCount;
  }
}

const originalXMLHttpRequest = globalThis.XMLHttpRequest;

function nextRequest(configure?: (request: MockXMLHttpRequest) => void): void {
  MockXMLHttpRequest.configureNext = configure;
}

function post(options: Partial<Parameters<typeof postValidationJson>[0]> = {}) {
  return postValidationJson({
    url: "https://executor.test/validate-features",
    headers: { "Content-Type": "application/json", "X-API-Key": "test-key" },
    body: '{"features":[1,2,3]}',
    ...options,
  });
}

function expectFailure(
  promise: Promise<unknown>,
  kind: ValidationTransportError["kind"],
): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    name: "ValidationTransportError",
    kind,
  }) as Promise<void>;
}

beforeAll(() => {
  globalThis.XMLHttpRequest = MockXMLHttpRequest as unknown as typeof XMLHttpRequest;
});

beforeEach(() => {
  jest.useFakeTimers();
  MockXMLHttpRequest.instances = [];
  MockXMLHttpRequest.configureNext = undefined;
  MockXMLHttpRequest.constructError = undefined;
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

afterAll(() => {
  globalThis.XMLHttpRequest = originalXMLHttpRequest;
});

describe("progress-aware validation JSON transport", () => {
  test("survives a moving upload beyond the previous 45-second deadline", async () => {
    const progress = jest.fn();
    nextRequest((request) => {
      request.onSend = () => {
        for (let second = 10; second <= 50; second += 10) {
          setTimeout(() => request.progress(second * 1_000, 50_000), second * 1_000);
        }
        setTimeout(() => request.completeUpload(), 50_000);
        setTimeout(() => request.respond(200, '{"valid":true}'), 60_000);
      };
    });

    const pending = post({ onUploadProgress: progress });
    await jest.advanceTimersByTimeAsync(45_001);
    expect(progress).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(14_999);
    await expect(pending).resolves.toEqual({ status: 200, body: '{"valid":true}' });
    expect(MockXMLHttpRequest.instances[0]?.listenerCountIncludingUpload).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("classifies a true upload stall and aborts the request", async () => {
    const pending = post();
    const rejected = expectFailure(pending, "stalled");
    await jest.advanceTimersByTimeAsync(VALIDATION_UPLOAD_STALL_TIMEOUT_MS);
    await rejected;
    expect(MockXMLHttpRequest.instances[0]?.abortCalls).toBe(1);
    expect(MockXMLHttpRequest.instances[0]?.listenerCountIncludingUpload).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("resets the stall timer only when loaded bytes increase", async () => {
    const progress = jest.fn();
    const pending = post({ onUploadProgress: progress });
    const rejected = expectFailure(pending, "stalled");
    const request = MockXMLHttpRequest.instances[0]!;

    await jest.advanceTimersByTimeAsync(10_000);
    request.progress(1_024, 4_096);
    await jest.advanceTimersByTimeAsync(15_000);
    request.progress(1_024, 4_096);
    await jest.advanceTimersByTimeAsync(5_000);

    await rejected;
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith({ loaded: 1_024, total: 4_096 });
  });

  test("tracks progress after the native HTTP client restarts an upload", async () => {
    const pending = post();
    const request = MockXMLHttpRequest.instances[0]!;

    request.progress(80, 100);
    await jest.advanceTimersByTimeAsync(19_000);
    request.progress(10, 100);
    await jest.advanceTimersByTimeAsync(2_000);
    request.respond(200, "{}");

    await expect(pending).resolves.toEqual({ status: 200, body: "{}" });
    expect(request.abortCalls).toBe(0);
  });

  test("stops the stall timer when upload completes", async () => {
    const pending = post();
    const request = MockXMLHttpRequest.instances[0]!;
    request.progress(1_024, 1_024);
    await jest.advanceTimersByTimeAsync(VALIDATION_UPLOAD_STALL_TIMEOUT_MS + 1);
    request.respond(200, "{}");

    await expect(pending).resolves.toEqual({ status: 200, body: "{}" });
  });

  test("derives the total deadline from challenge expiry with a one-second margin", async () => {
    const pending = post({ deadlineAtMs: performance.now() + 26_000 });
    const rejected = expectFailure(pending, "deadline");
    const request = MockXMLHttpRequest.instances[0]!;
    request.progress(1_024);
    await jest.advanceTimersByTimeAsync(10_000);
    request.progress(2_048);
    await jest.advanceTimersByTimeAsync(10_000);
    request.progress(3_072);
    await jest.advanceTimersByTimeAsync(5_000);

    await rejected;
    expect(request.abortCalls).toBe(1);
    expect(request.listenerCountIncludingUpload).toBe(0);
  });

  test("keeps a bounded total deadline for direct callers", async () => {
    const pending = post();
    const rejected = expectFailure(pending, "deadline");
    const request = MockXMLHttpRequest.instances[0]!;
    request.completeUpload();
    await jest.advanceTimersByTimeAsync(VALIDATION_DEFAULT_TOTAL_TIMEOUT_MS);

    await rejected;
    expect(request.abortCalls).toBe(1);
    expect(request.listenerCountIncludingUpload).toBe(0);
  });

  test("distinguishes caller aborts from network failures", async () => {
    const controller = new AbortController();
    const aborted = post({ signal: controller.signal });
    const abortedFailure = expectFailure(aborted, "aborted");
    const abortedRequest = MockXMLHttpRequest.instances[0]!;
    controller.abort();
    await abortedFailure;
    expect(abortedRequest.abortCalls).toBe(1);
    expect(abortedRequest.listenerCountIncludingUpload).toBe(0);

    const network = post();
    const networkFailure = expectFailure(network, "network");
    const networkRequest = MockXMLHttpRequest.instances[1]!;
    networkRequest.failNetwork();
    await networkFailure;
    expect(networkRequest.abortCalls).toBe(0);
    expect(networkRequest.listenerCountIncludingUpload).toBe(0);
  });

  test("posts JSON headers and returns response text for parsing", async () => {
    nextRequest((request) => {
      request.onSend = () => request.respond(429, '{"retry_after":30}');
    });
    await expect(post()).resolves.toEqual({ status: 429, body: '{"retry_after":30}' });

    const request = MockXMLHttpRequest.instances[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://executor.test/validate-features");
    expect(request.async).toBe(true);
    expect(request.headers).toEqual({
      "Content-Type": "application/json",
      "X-API-Key": "test-key",
    });
    expect(request.sentBody).toBe('{"features":[1,2,3]}');
    expect(request.listenerCountIncludingUpload).toBe(0);
  });

  test("contains progress observer failures without disrupting the upload", async () => {
    const pending = post({
      onUploadProgress: () => {
        throw new Error("observer failed");
      },
    });
    const request = MockXMLHttpRequest.instances[0]!;

    expect(() => request.progress(1_024, 4_096)).not.toThrow();
    request.progress(4_096, 4_096);
    request.respond(200, '{"valid":true}');

    await expect(pending).resolves.toEqual({ status: 200, body: '{"valid":true}' });
    expect(request.listenerCountIncludingUpload).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("does not re-arm timers when a progress observer aborts the request", async () => {
    const controller = new AbortController();
    const pending = post({
      signal: controller.signal,
      onUploadProgress: () => controller.abort(),
    });
    const rejected = expectFailure(pending, "aborted");
    const request = MockXMLHttpRequest.instances[0]!;

    request.progress(1_024, 4_096);

    await rejected;
    expect(request.abortCalls).toBe(1);
    expect(request.listenerCountIncludingUpload).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("classifies synchronous send errors and cleans every resource", async () => {
    nextRequest((request) => {
      request.sendError = new Error("send failed");
    });
    const pending = post();
    await expectFailure(pending, "network");

    const request = MockXMLHttpRequest.instances[0]!;
    expect(request.abortCalls).toBe(1);
    expect(request.listenerCountIncludingUpload).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("classifies synchronous constructor errors", async () => {
    MockXMLHttpRequest.constructError = new Error("constructor failed");

    await expectFailure(post(), "network");

    expect(MockXMLHttpRequest.instances).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });
});
