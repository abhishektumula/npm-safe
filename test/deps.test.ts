import { afterEach, describe, expect, test } from "bun:test";
import { countTransitive } from "../src/deps.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

// Unique graph per test: deps.ts caches by package name module-wide.
function stubGraph(graph: Record<string, string[]>) {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const name = String(url).split("/").at(-2) ?? "";
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
}

describe("countTransitive", () => {
  test("dedupes shared deps and excludes direct ones", async () => {
    stubGraph({ a1: ["c1"], b1: ["c1", "d1"], c1: [], d1: [] });
    const { count, names } = await countTransitive(["a1", "b1"]);
    expect(count).toBe(2);
    expect(names).toEqual(["c1", "d1"]);
  });
  test("survives cycles", async () => {
    stubGraph({ a2: ["b2"], b2: ["a2"] });
    const { count, names } = await countTransitive(["a2"]);
    expect(count).toBe(1);
    expect(names).toEqual(["b2"]);
  });
  test("empty direct list counts nothing", async () => {
    stubGraph({});
    expect(await countTransitive([])).toEqual({ count: 0, names: [] });
  });
  test("unresolvable deps count as leaves", async () => {
    globalThis.fetch = (async () => ({ status: 404, ok: false })) as unknown as typeof fetch;
    const { count, names } = await countTransitive(["ghost-pkg-zzz"]);
    expect(count).toBe(0);
    expect(names).toEqual([]);
  });
});
