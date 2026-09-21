import { afterEach, describe, expect, test } from "bun:test";
import { inspectOne, inspectPackages } from "../src/inspect.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const HEALTH_HTML = `<span class="score-number">90/100</span>
<span class="criterion-label">security</span><span>No known security issues</span>`;

function stubIntel(graph: Record<string, string[]>, missing: string[] = []) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("security.snyk.io")) {
      return { status: 200, ok: true, text: async () => HEALTH_HTML };
    }
    const name = u.split("/").at(-2) ?? "";
    if (missing.includes(name)) return { status: 404, ok: false, json: async () => ({}) };
    return {
      status: 200,
      ok: true,
      json: async () => ({
        name,
        version: "1.0.0",
        description: `${name} package`,
        author: "tester",
        license: "MIT",
        repository: "https://github.com/test/test",
        dependencies: Object.fromEntries((graph[name] ?? []).map((d) => [d, "^1"])),
        maintainers: [],
      }),
    };
  }) as unknown as typeof fetch;
}

describe("inspectOne", () => {
  test("full report with transitive counts", async () => {
    stubIntel({ pkga: ["depa"], depa: ["granda"], granda: [] });
    const r = await inspectOne("pkga");
    expect(r.meta?.name).toBe("pkga");
    expect(r.directCount).toBe(1);
    expect(r.transitiveCount).toBe(1);
    expect(r.totalCount).toBe(2);
    expect(r.transitiveNames).toEqual(["granda"]);
    expect(r.health.score).toBe(90);
    expect(r.metaError).toBeNull();
    expect(r.truncated).toBe(false);
  });
  test("versioned query looks up the bare name", async () => {
    stubIntel({ pkgb: [] });
    const r = await inspectOne("pkgb@2.0.0");
    expect(r.query).toBe("pkgb@2.0.0");
    expect(r.meta?.name).toBe("pkgb");
  });
  test("missing package keeps query and error", async () => {
    stubIntel({}, ["ghost"]);
    const r = await inspectOne("ghost");
    expect(r.meta).toBeNull();
    expect(r.metaError).toMatch(/not found/);
    expect(r.totalCount).toBe(0);
    expect(r.health.score).toBe(90);
  });
  test("non-registry query fails fast without any fetch", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { status: 200, ok: true, json: async () => ({}), text: async () => "" };
    }) as unknown as typeof fetch;
    const r = await inspectOne("file:./local");
    expect(r.meta).toBeNull();
    expect(r.metaError).toMatch(/invalid package name/);
    expect(calls).toBe(0);
  });
  test("registry throw becomes a meta error, not a crash", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes("security.snyk.io")) {
        return { status: 200, ok: true, text: async () => HEALTH_HTML };
      }
      throw new Error("net down");
    }) as unknown as typeof fetch;
    const r = await inspectOne("anypkg");
    expect(r.meta).toBeNull();
    expect(r.metaError).toBe("net down");
  });
});

describe("inspectPackages", () => {
  test("preserves input order", async () => {
    stubIntel({ z1: [], a1: [] });
    const rs = await inspectPackages(["z1", "a1"]);
    expect(rs.map((r) => r.query)).toEqual(["z1", "a1"]);
  });
});
