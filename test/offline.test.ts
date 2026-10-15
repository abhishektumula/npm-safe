import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cacheStats,
  clearIntelCache,
  getCacheFile,
  getCacheStale,
  purgeIntelCache,
  setCache,
  STALE_WINDOW_MS,
} from "../src/cache.ts";
import { clearNpmInflight, fetchNpmMeta, installScriptsOf } from "../src/npm.ts";
import { clearHealthInflight, fetchHealth } from "../src/snyk.ts";
import { clearDepsCache } from "../src/deps.ts";
import { inspectPackages } from "../src/inspect.ts";
import { clearOsvInflight } from "../src/osv.ts";
import { setColorEnabled, colorEnabled, paint, c } from "../src/colors.ts";
import { fetchWithRetry } from "../src/fetch.ts";

const realFetch = globalThis.fetch;
const realNow = Date.now;
const realCacheDir = process.env.NPS_CACHE_DIR;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nps-offline-"));
  process.env.NPS_CACHE_DIR = dir;
  clearIntelCache();
  clearNpmInflight();
  clearHealthInflight();
  clearOsvInflight();
  clearDepsCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  if (realCacheDir === undefined) delete process.env.NPS_CACHE_DIR;
  else process.env.NPS_CACHE_DIR = realCacheDir;
  rmSync(dir, { recursive: true, force: true });
});

const later = (ms: number) => {
  Date.now = () => realNow() + ms;
};
const DAY = 24 * 3600 * 1000;

describe("stale cache", () => {
  test("getCacheStale serves expired entries only inside the window", () => {
    setCache("k", { v: 1 }, 1000);
    later(DAY);
    expect(getCacheStale<{ v: number }>("k")).toEqual({ v: 1 });
    later(STALE_WINDOW_MS + DAY);
    expect(getCacheStale("k")).toBeNull();
  });
  test("NPS_NO_CACHE disables the stale path", () => {
    setCache("k2", 1, 1000);
    process.env.NPS_NO_CACHE = "1";
    try {
      expect(getCacheStale("k2")).toBeNull();
    } finally {
      delete process.env.NPS_NO_CACHE;
    }
  });
  test("registry down -> stale meta, labelled", async () => {
    globalThis.fetch = (async () => ({
      status: 200,
      ok: true,
      json: async () => ({ name: "offpkg", version: "1.0.0", dependencies: {} }),
    })) as unknown as typeof fetch;
    await fetchNpmMeta("offpkg");
    later(2 * DAY);
    globalThis.fetch = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    clearNpmInflight();
    const m = await fetchNpmMeta("offpkg");
    expect(m.stale).toBe(true);
    expect(m.version).toBe("1.0.0");
  });
  test("registry 5xx -> stale; 404 never falls back; no entry still throws", async () => {
    globalThis.fetch = (async () => ({
      status: 200,
      ok: true,
      json: async () => ({ name: "offpkg2", version: "1.0.0" }),
    })) as unknown as typeof fetch;
    await fetchNpmMeta("offpkg2");
    later(2 * DAY);
    globalThis.fetch = (async () => ({
      status: 502,
      ok: false,
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;
    clearNpmInflight();
    expect((await fetchNpmMeta("offpkg2")).stale).toBe(true);
    globalThis.fetch = (async () => ({ status: 404, ok: false })) as unknown as typeof fetch;
    clearNpmInflight();
    await expect(fetchNpmMeta("offpkg2")).rejects.toThrow("not found");
    globalThis.fetch = (async () => ({
      status: 500,
      ok: false,
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof fetch;
    clearNpmInflight();
    await expect(fetchNpmMeta("neverseen")).rejects.toThrow("responded 500");
  });
  test("snyk unreachable -> stale health", async () => {
    globalThis.fetch = (async () => ({
      status: 200,
      ok: true,
      text: async () => `<span class="score-number">70/100</span>`,
    })) as unknown as typeof fetch;
    await fetchHealth("offpkg3");
    later(2 * DAY);
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    clearHealthInflight();
    const h = await fetchHealth("offpkg3");
    expect(h.score).toBe(70);
    expect(h.stale).toBe(true);
  });
  test("an all-stale inspection is labelled stale on the report", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("snyk"))
        return {
          status: 200,
          ok: true,
          text: async () => `<span class="score-number">70/100</span>`,
        };
      if (u.includes("osv")) return { status: 200, ok: true, text: async () => "{}" };
      return {
        status: 200,
        ok: true,
        json: async () => ({ name: "offpkg4", version: "1.0.0", dependencies: {} }),
      };
    }) as unknown as typeof fetch;
    await inspectPackages(["offpkg4"]);
    later(2 * DAY);
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    clearNpmInflight();
    clearHealthInflight();
    clearOsvInflight();
    clearDepsCache();
    const [r] = await inspectPackages(["offpkg4"]);
    expect(r!.stale).toBe(true);
    expect(r!.meta?.name).toBe("offpkg4");
    expect(r!.vulns?.stale).toBe(true);
  });
});

describe("cache stats + purge", () => {
  test("stats reflect the file; purge deletes it and reports the count", () => {
    writeFileSync(
      getCacheFile(),
      JSON.stringify({ a: { exp: 1, data: 1 }, b: { exp: 1, data: 2 } }),
    );
    const s = cacheStats();
    expect(s.entries).toBe(2);
    expect(s.bytes).toBeGreaterThan(0);
    expect(s.enabled).toBe(true);
    expect(purgeIntelCache()).toBe(2);
    expect(existsSync(getCacheFile())).toBe(false);
    expect(cacheStats().entries).toBe(0);
  });
});

describe("install scripts", () => {
  test("detects hooks and implicit node-gyp", () => {
    expect(installScriptsOf({ scripts: { postinstall: "x", test: "y" } })).toEqual(["postinstall"]);
    expect(installScriptsOf({ gypfile: true })).toEqual(["install"]);
    expect(installScriptsOf({ gypfile: true, scripts: { install: "x" } })).toEqual(["install"]);
    expect(installScriptsOf({ scripts: { preinstall: "" } })).toEqual([]);
    expect(installScriptsOf({})).toEqual([]);
  });
});

describe("inspectPackages options", () => {
  test("bounded concurrency preserves order; skipDeps skips the crawl", async () => {
    let active = 0;
    let peak = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      if (u.includes("snyk"))
        return {
          status: 200,
          ok: true,
          text: async () => `<span class="score-number">70/100</span>`,
        };
      if (u.includes("osv")) return { status: 200, ok: true, text: async () => "{}" };
      const name = u.split("/").at(-2)!;
      return {
        status: 200,
        ok: true,
        json: async () => ({ name, version: "1.0.0", dependencies: { child: "^1" } }),
      };
    }) as unknown as typeof fetch;
    const names = ["cc1", "cc2", "cc3", "cc4", "cc5", "cc6"];
    const rs = await inspectPackages(names, {
      concurrency: 2,
      skipDeps: true,
      versionFor: () => "9.9.9",
    });
    expect(rs.map((r) => r.query)).toEqual(names);
    expect(rs.every((r) => r.transitiveCount === 0 && r.directCount === 1)).toBe(true);
    expect(peak).toBeLessThanOrEqual(2 * 3); // 2 workers x (meta + snyk + osv)
  });
});

describe("colors toggle", () => {
  test("setColorEnabled and NO_COLOR gate paint()", () => {
    const prev = process.env.NO_COLOR;
    try {
      delete process.env.NO_COLOR;
      setColorEnabled(true);
      expect(colorEnabled()).toBe(true);
      expect(paint(c.red, "x")).toContain("\x1b[");
      process.env.NO_COLOR = "1";
      expect(paint(c.red, "x")).toBe("x");
      process.env.NO_COLOR = "";
      expect(colorEnabled()).toBe(true);
      delete process.env.NO_COLOR;
      setColorEnabled(false);
      expect(paint(c.red, "x")).toBe("x");
    } finally {
      setColorEnabled(true);
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });
});

describe("fetchWithRetry POST", () => {
  test("forwards method and body", async () => {
    let seen: { method?: string; body?: string } = {};
    globalThis.fetch = (async (_u: string, init: { method?: string; body?: string }) => {
      seen = init;
      return { status: 200, ok: true };
    }) as unknown as typeof fetch;
    await fetchWithRetry("https://x.test", { method: "POST", body: "{}" });
    expect(seen).toMatchObject({ method: "POST", body: "{}" });
  });
});
