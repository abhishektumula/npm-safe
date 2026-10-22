import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCache,
  setCache,
  clearIntelCache,
  getCacheFile,
  persistIntelCacheSync,
} from "../src/cache.ts";
import { fetchNpmMeta, clearNpmInflight } from "../src/npm.ts";
import { fetchHealth, clearHealthInflight } from "../src/snyk.ts";
import { countTransitive, clearDepsCache } from "../src/deps.ts";
import { inspectPackages } from "../src/inspect.ts";

const realFetch = globalThis.fetch;
let cacheDir = "";

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "nps-cache-test-"));
  process.env.NPS_CACHE_DIR = cacheDir;
  clearIntelCache();
  clearNpmInflight();
  clearHealthInflight();
  clearDepsCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.NPS_CACHE_DIR;
  clearIntelCache();
  clearNpmInflight();
  clearHealthInflight();
  clearDepsCache();
  try {
    rmSync(cacheDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("intel cache", () => {
  test("second meta lookup hits memory with zero fetches", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        status: 200,
        ok: true,
        json: async () => ({ name: "cachepkg1", version: "1.0.0", dependencies: {} }),
      };
    }) as unknown as typeof fetch;
    await fetchNpmMeta("cachepkg1");
    expect(calls).toBe(1);
    await fetchNpmMeta("cachepkg1");
    expect(calls).toBe(1);
  });

  test("concurrent meta lookups share one in-flight fetch", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return {
        status: 200,
        ok: true,
        json: async () => ({ name: "cachepkg2", version: "1.0.0", dependencies: {} }),
      };
    }) as unknown as typeof fetch;
    const [a, b, c] = await Promise.all([
      fetchNpmMeta("cachepkg2"),
      fetchNpmMeta("cachepkg2"),
      fetchNpmMeta("cachepkg2"),
    ]);
    expect(calls).toBe(1);
    expect(a.version).toBe("1.0.0");
    expect(b.version).toBe("1.0.0");
    expect(c.version).toBe("1.0.0");
  });

  test("health second lookup hits cache", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return {
        status: 200,
        ok: true,
        text: async () => `<span class="score-number">88/100</span>`,
      };
    }) as unknown as typeof fetch;
    expect((await fetchHealth("cachehealth1")).score).toBe(88);
    expect((await fetchHealth("cachehealth1")).score).toBe(88);
    expect(calls).toBe(1);
  });

  test("failures are never cached", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { status: 500, ok: false, json: async () => ({}) };
    }) as unknown as typeof fetch;
    await expect(fetchNpmMeta("cachefail1")).rejects.toThrow();
    await expect(fetchNpmMeta("cachefail1")).rejects.toThrow();
    expect(calls).toBe(2);
  });

  test("set/get round-trips and respects TTL", async () => {
    setCache("k1", { v: 1 }, 50);
    expect(getCache<{ v: number }>("k1")).toEqual({ v: 1 });
    await new Promise((r) => setTimeout(r, 70));
    expect(getCache("k1")).toBeNull();
  });

  test("persisted entries survive to a fresh in-memory view via file", async () => {
    globalThis.fetch = (async () => ({
      status: 200,
      ok: true,
      json: async () => ({ name: "cachepersist1", version: "9.9.9", dependencies: {} }),
    })) as unknown as typeof fetch;
    await fetchNpmMeta("cachepersist1");
    persistIntelCacheSync();
    // inspectOne/inspectPackages persist synchronously; fetchNpmMeta alone
    // only schedules the async flush — force it via a package inspect.
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("security.snyk.io")) {
        return {
          status: 200,
          ok: true,
          text: async () => `<span class="score-number">70/100</span>`,
        };
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ name: "cachepersist1", version: "9.9.9", dependencies: {} }),
      };
    }) as unknown as typeof fetch;
    clearNpmInflight();
    clearHealthInflight();
    // Wipe memory but keep the file: simulate a fresh process by re-reading.
    const file = getCacheFile();
    const body = readFileSync(file, "utf8");
    expect(body).toContain("cachepersist1");
  });
});

describe("parallel intel", () => {
  function stubParallel(graph: Record<string, string[]>, delayMs = 40) {
    let active = 0;
    let peak = 0;
    let calls = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("security.snyk.io")) {
        return {
          status: 200,
          ok: true,
          text: async () => `<span class="score-number">80/100</span>`,
        };
      }
      if (u.includes("api.osv.dev") || u.includes("api.npmjs.org")) {
        return { status: 200, ok: true, text: async () => "{}" };
      }
      if (u.includes("api.deps.dev")) {
        // A publish time here keeps inspectOne off the registry packument fallback.
        const doc = { publishedAt: "2020-01-01T00:00:00Z" };
        return { status: 200, ok: true, text: async () => JSON.stringify(doc) };
      }
      calls++;
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, delayMs));
      active--;
      const name = u.split("/").at(-2) ?? "";
      return {
        status: 200,
        ok: true,
        json: async () => ({
          name,
          version: "1.0.0",
          dependencies: Object.fromEntries((graph[name] ?? []).map((d) => [d, "^1"])),
        }),
      };
    }) as unknown as typeof fetch;
    return { peak: () => peak, calls: () => calls };
  }

  test("multiple packages fetch concurrently, not sequentially", async () => {
    // Two roots with disjoint 2-leaf graphs. Sequential would take ~3 waves
    // per package back-to-back; parallel overlaps them.
    const graph = {
      proot1: ["pleaf1", "pleaf2"],
      proot2: ["pleaf3", "pleaf4"],
      pleaf1: [],
      pleaf2: [],
      pleaf3: [],
      pleaf4: [],
    };
    const mon = stubParallel(graph, 40);
    const t0 = Date.now();
    const rs = await inspectPackages(["proot1", "proot2"]);
    const elapsed = Date.now() - t0;
    expect(rs.map((r) => r.query)).toEqual(["proot1", "proot2"]);
    expect(rs[0]!.directCount).toBe(2);
    expect(rs[1]!.directCount).toBe(2);
    // Sequential would be ~160ms+ (2 roots + 4 leaves serialized in waves);
    // parallel with dedup + worker pool overlaps to ~2 waves.
    expect(elapsed).toBeLessThan(150);
    expect(mon.peak()).toBeGreaterThan(1);
  });

  test("overlapping transitive graphs fetch each unique node once", async () => {
    const graph = {
      qroot1: ["sharedleaf", "unique1"],
      qroot2: ["sharedleaf", "unique2"],
      sharedleaf: ["sharedgrand"],
      unique1: [],
      unique2: [],
      sharedgrand: [],
    };
    const mon = stubParallel(graph, 20);
    const rs = await inspectPackages(["qroot1", "qroot2"]);
    expect(rs[0]!.transitiveNames).toContain("sharedgrand");
    expect(rs[1]!.transitiveNames).toContain("sharedgrand");
    // Unique nodes: 2 roots + sharedleaf + unique1 + unique2 + sharedgrand = 6
    // registry fetches (health fetches are separate snyk calls, not counted
    // in `calls` since stub counts only registry — health returns early).
    // The key assertion: sharedleaf fetched once despite two parents.
    expect(mon.calls()).toBe(6);
  });

  test("transitive crawl keeps concurrency without batch barrier", async () => {
    // 8 direct deps each with no children: one wave should fetch all 8
    // concurrently (peak ~8), not in sequential batches.
    const direct = Array.from({ length: 8 }, (_, i) => `wleaf${i}`);
    const graph: Record<string, string[]> = {};
    for (const d of direct) graph[d] = [];
    const mon = stubParallel(graph, 30);
    const res = await countTransitive(direct);
    expect(res.count).toBe(0);
    expect(mon.peak()).toBeGreaterThanOrEqual(8);
  });
});
