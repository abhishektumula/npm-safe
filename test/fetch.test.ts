import { afterEach, describe, expect, test } from "bun:test";
import { fetchWithRetry } from "../src/fetch.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubSequence(responses: Array<{ status: number; body?: string; retryAfter?: string }>) {
  let calls = 0;
  globalThis.fetch = (async () => {
    const next = responses[Math.min(calls++, responses.length - 1)]!;
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      headers: {
        get: (name: string) => (name === "retry-after" ? (next.retryAfter ?? null) : null),
      },
      text: async () => next.body ?? "",
    };
  }) as unknown as typeof fetch;
  return () => calls;
}

describe("fetchWithRetry", () => {
  test("passes through success without retrying", async () => {
    const calls = stubSequence([{ status: 200, body: "ok" }]);
    const res = await fetchWithRetry("https://x.example", {}, { defaultBackoffMs: 1 });
    expect(res.status).toBe(200);
    expect(calls()).toBe(1);
  });
  test("retries 429 once and returns the follow-up", async () => {
    const calls = stubSequence([
      { status: 429, retryAfter: "0" },
      { status: 200, body: "recovered" },
    ]);
    const res = await fetchWithRetry("https://x.example", {}, { defaultBackoffMs: 1 });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("recovered");
    expect(calls()).toBe(2);
  });
  test("gives up after maxAttempts", async () => {
    const calls = stubSequence([{ status: 503, retryAfter: "0" }]);
    const res = await fetchWithRetry(
      "https://x.example",
      {},
      { maxAttempts: 3, defaultBackoffMs: 1 },
    );
    expect(res.status).toBe(503);
    expect(calls()).toBe(3);
  });
  test("does not retry 404 or 500", async () => {
    const calls404 = stubSequence([{ status: 404 }]);
    expect((await fetchWithRetry("https://x.example")).status).toBe(404);
    expect(calls404()).toBe(1);
    const calls500 = stubSequence([{ status: 500 }]);
    expect((await fetchWithRetry("https://x.example")).status).toBe(500);
    expect(calls500()).toBe(1);
  });
  test("retries gateway errors", async () => {
    for (const status of [502, 504]) {
      const calls = stubSequence([{ status }, { status: 200, body: "ok" }]);
      const res = await fetchWithRetry("https://x.example", {}, { defaultBackoffMs: 1 });
      expect(res.status).toBe(200);
      expect(calls()).toBe(2);
    }
  });
  test("network failure retries once, then throws", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error("net down");
    }) as unknown as typeof fetch;
    await expect(fetchWithRetry("https://x.example", {}, { defaultBackoffMs: 1 })).rejects.toThrow(
      "net down",
    );
    expect(calls).toBe(2);
  });
  test("a dropped connection recovers on the second attempt", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      if (calls++ === 0) throw new Error("socket hang up");
      return { status: 200, ok: true };
    }) as unknown as typeof fetch;
    const res = await fetchWithRetry("https://x.example", {}, { defaultBackoffMs: 1 });
    expect(res.status).toBe(200);
  });
});
