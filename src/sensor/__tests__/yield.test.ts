import { yieldToMainThread } from "@/lib/yield";

afterEach(() => {
  jest.useRealTimers();
});

describe("yieldToMainThread", () => {
  test("resolves while fake timers are active", async () => {
    expect(typeof MessageChannel).toBe("function");
    jest.useFakeTimers();

    await expect(yieldToMainThread()).resolves.toBeUndefined();
  });
});
