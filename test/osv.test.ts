import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearIntelCache, STALE_WINDOW_MS } from "../src/cache.ts";
import { clearOsvInflight, fetchVulns, summarizeOsv } from "../src/osv.ts";

const realFetch = globalThis.fetch;
beforeEach(() => {
  clearIntelCache();
  clearOsvInflight();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const body = {
  vulns: [
    { id: "GHSA-1", database_specific: { severity: "MODERATE" } },
    { id: "GHSA-2", database_specific: { severity: "HIGH" } },
    { id: "GHSA-3" },
  ],
};

function stub(
  status: number,
  payload: unknown,
  seen: { calls: number; body?: string } = { calls: 0 },
) {
  globalThis.fetch = (async (_u: string, init?: { body?: string }) => {
    seen.calls++;
    seen.body = init?.body;
    return { status, ok: status < 400, text: async () => JSON.stringify(payload) };
  }) as unknown as typeof fetch;
  return seen;
}

describe("summarizeOsv", () => {
  test("counts, caps ids, keeps worst severity", () => {
    expect(summarizeOsv(body)).toEqual({
      count: 3,
      ids: ["GHSA-1", "GHSA-2", "GHSA-3"],
      worst: "high",
    });
  });
  test("medium maps to moderate; empty/garbage is zero", () => {
    expect(
      summarizeOsv({ vulns: [{ id: "a", database_specific: { severity: "MEDIUM" } }] }).worst,
    ).toBe("moderate");
    expect(summarizeOsv({})).toEqual({ count: 0, ids: [], worst: null });
    expect(summarizeOsv(null)).toEqual({ count: 0, ids: [], worst: null });
  });
});

describe("fetchVulns", () => {
  test("POSTs name+version and parses", async () => {
    const seen = stub(200, body);
    const v = await fetchVulns("osvpkg1", "1.2.3");
    expect(v?.count).toBe(3);
    expect(JSON.parse(seen.body!)).toEqual({
      package: { name: "osvpkg1", ecosystem: "npm" },
      version: "1.2.3",
    });
  });
  test("second call is served from cache", async () => {
    const seen = stub(200, body);
    await fetchVulns("osvpkg2", "1.0.0");
    await fetchVulns("osvpkg2", "1.0.0");
    expect(seen.calls).toBe(1);
  });
  test("HTTP error and bad input degrade to null", async () => {
    stub(500, {});
    expect(await fetchVulns("osvpkg3", "1.0.0")).toBeNull();
    expect(await fetchVulns("file:./x", "1.0.0")).toBeNull();
    expect(await fetchVulns("osvpkg3", "n/a")).toBeNull();
  });
  test("network failure falls back to stale cache, labelled", async () => {
    const real = Date.now;
    stub(200, body);
    await fetchVulns("osvpkg4", "1.0.0");
    // 25h later the entry is expired but inside the stale window.
    Date.now = () => real() + 25 * 3600 * 1000;
    try {
      globalThis.fetch = (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch;
      clearOsvInflight();
      const v = await fetchVulns("osvpkg4", "1.0.0");
      expect(v?.stale).toBe(true);
      expect(v?.count).toBe(3);
      // Past the stale window there is nothing to fall back to.
      Date.now = () => real() + STALE_WINDOW_MS + 48 * 3600 * 1000;
      expect(await fetchVulns("osvpkg4", "1.0.0")).toBeNull();
    } finally {
      Date.now = real;
    }
  });
});
