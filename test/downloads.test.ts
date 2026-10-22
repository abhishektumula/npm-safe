import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearDownloadsInflight,
  fetchWeeklyDownloads,
  formatCount,
  LOW_DOWNLOADS,
} from "../src/downloads.ts";
import { clearIntelCache } from "../src/cache.ts";
import { clearNpmInflight } from "../src/npm.ts";
import { clearHealthInflight } from "../src/snyk.ts";
import { clearOsvInflight } from "../src/osv.ts";
import { clearDepsCache } from "../src/deps.ts";
import { clearNpmrcCache } from "../src/npmrc.ts";
import {
  clearPolicyCache,
  emptyPolicy,
  evaluate,
  parsePolicy,
  snykEnabled,
} from "../src/policy.ts";
import { inspectOne } from "../src/inspect.ts";
import { advisoryText, render, signalWarnings } from "../src/render.ts";
import { stripAnsi } from "./helper.ts";

const realFetch = globalThis.fetch;
const realHome = process.env.HOME;
const realCacheDir = process.env.NPS_CACHE_DIR;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nps-dl-"));
  process.env.HOME = dir;
  process.env.NPS_CACHE_DIR = join(dir, "cache");
  for (const f of [
    clearIntelCache,
    clearDownloadsInflight,
    clearNpmInflight,
    clearHealthInflight,
    clearOsvInflight,
    clearDepsCache,
    clearNpmrcCache,
    clearPolicyCache,
  ])
    f();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realCacheDir === undefined) delete process.env.NPS_CACHE_DIR;
  else process.env.NPS_CACHE_DIR = realCacheDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("fetchWeeklyDownloads", () => {
  test("parses, encodes scoped names, caches", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (u: string) => {
      urls.push(u);
      return { status: 200, ok: true, json: async () => ({ downloads: 4200 }) };
    }) as unknown as typeof fetch;
    expect(await fetchWeeklyDownloads("@scope/dlpkg")).toBe(4200);
    expect(await fetchWeeklyDownloads("@scope/dlpkg")).toBe(4200);
    expect(urls).toEqual(["https://api.npmjs.org/downloads/point/last-week/@scope/dlpkg"]);
  });
  test("bad payloads, HTTP errors, throws and invalid names are null", async () => {
    globalThis.fetch = (async () => ({
      status: 200,
      ok: true,
      json: async () => ({ downloads: "x" }),
    })) as unknown as typeof fetch;
    expect(await fetchWeeklyDownloads("dlbad1")).toBeNull();
    globalThis.fetch = (async () => ({ status: 404, ok: false })) as unknown as typeof fetch;
    expect(await fetchWeeklyDownloads("dlbad2")).toBeNull();
    globalThis.fetch = (async () => {
      throw new Error("x");
    }) as unknown as typeof fetch;
    expect(await fetchWeeklyDownloads("dlbad3")).toBeNull();
    expect(await fetchWeeklyDownloads("file:./x")).toBeNull();
  });
});

test("formatCount", () => {
  expect(formatCount(7)).toBe("7");
  expect(formatCount(1234)).toBe("1.2K");
  expect(formatCount(3_400_000)).toBe("3.4M");
  expect(formatCount(2_100_000_000)).toBe("2.1B");
});

function stubAll(downloads: number, seen: string[] = []) {
  globalThis.fetch = (async (u: string) => {
    seen.push(u);
    if (u.includes("api.npmjs.org"))
      return { status: 200, ok: true, json: async () => ({ downloads }) };
    if (u.includes("api.osv.dev")) return { status: 200, ok: true, text: async () => "{}" };
    if (u.includes("snyk"))
      return {
        status: 200,
        ok: true,
        text: async () => `<span class="score-number">70/100</span>`,
      };
    return {
      status: 200,
      ok: true,
      json: async () => ({ name: "dlpkg", version: "1.0.0", dependencies: {} }),
    };
  }) as unknown as typeof fetch;
}

describe("inspect integration", () => {
  test("downloads flow into the report, signals and card", async () => {
    stubAll(12);
    const r = await inspectOne("dlpkg", { cwd: dir });
    expect(r.downloads).toBe(12);
    expect(r.signals?.lowDownloads).toBe(true);
    expect(12).toBeLessThan(LOW_DOWNLOADS);
    expect(signalWarnings(r)).toContain("rarely used (under 100 downloads/week)");
    expect(stripAnsi(render([r], false))).toContain("12 downloads/week");
  });
  test("custom registry (--registry or .npmrc) skips the public downloads API", async () => {
    const seen: string[] = [];
    stubAll(5000, seen);
    const r = await inspectOne("dlpkg", { cwd: dir, registry: "https://npm.acme.com" });
    expect(r.downloads).toBeNull();
    expect(seen.some((u) => u.includes("api.npmjs.org"))).toBe(false);
    clearIntelCache();
    clearNpmInflight();
    clearDownloadsInflight();
    clearNpmrcCache();
    writeFileSync(join(dir, ".npmrc"), "registry=https://npm.acme.com/\n");
    const r2 = await inspectOne("dlpkg", { cwd: dir });
    expect(r2.downloads).toBeNull();
  });
  test("noSnyk skips the scrape and marks health skipped", async () => {
    const seen: string[] = [];
    stubAll(5000, seen);
    const r = await inspectOne("dlpkg", { cwd: dir, noSnyk: true });
    // OSV + downloads answered, so nps estimates instead of showing n/a.
    expect(r.health).toMatchObject({ source: "estimate", skipped: true });
    expect(r.health.score).toBeGreaterThan(0);
    expect(seen.some((u) => u.includes("snyk"))).toBe(false);
    expect(stripAnsi(render([r], false))).toContain("(nps estimate: snyk disabled)");
  });
  test("advisoryText stays null when OSV was never queried", () => {
    expect(advisoryText({ vulns: undefined } as never)).toBeNull();
  });
});

describe("policy: minWeeklyDownloads + sources", () => {
  test("blocks rarely-used packages, unknown passes", async () => {
    stubAll(30);
    const low = await inspectOne("dlpkg", { cwd: dir });
    const pol = parsePolicy({ policy: { minWeeklyDownloads: 100 } });
    expect(evaluate([low], pol)[0]?.rule).toBe("downloads");
    expect(evaluate([{ ...low, downloads: null }], pol)).toEqual([]);
    expect(evaluate([{ ...low, downloads: 5000 }], pol)).toEqual([]);
    expect(evaluate([low], emptyPolicy())).toEqual([]);
  });
  test("snykEnabled reads sources.snyk, fails open", () => {
    expect(snykEnabled(dir)).toBe(true);
    clearPolicyCache();
    writeFileSync(join(dir, "nps.config.json"), JSON.stringify({ sources: { snyk: false } }));
    expect(snykEnabled(dir)).toBe(false);
    clearPolicyCache();
    writeFileSync(join(dir, "nps.config.json"), "{bad");
    expect(snykEnabled(dir)).toBe(true);
  });
});
