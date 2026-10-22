import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearNpmInflight,
  fetchNpmMeta,
  fetchPublishedAt,
  MAX_PACKUMENT_BYTES,
  resolveVersion,
  specPath,
} from "../src/npm.ts";
import { clearIntelCache } from "../src/cache.ts";
import { clearDepsCache } from "../src/deps.ts";
import { clearNpmrcCache } from "../src/npmrc.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realFetch = globalThis.fetch;
const realToken = process.env.NPM_TOKEN;
const realHome = process.env.HOME;
let fakeHome = "";

beforeEach(() => {
  // Hermetic: a developer's real ~/.npmrc token must not leak into tests.
  fakeHome = mkdtempSync(join(tmpdir(), "nps-npm-home-"));
  process.env.HOME = fakeHome;
  clearNpmrcCache();
  clearIntelCache();
  clearNpmInflight();
  clearDepsCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(fakeHome, { recursive: true, force: true });
  clearNpmrcCache();
  if (realToken === undefined) delete process.env.NPM_TOKEN;
  else process.env.NPM_TOKEN = realToken;
});

function stubFetch(payload: unknown, status = 200) {
  globalThis.fetch = (async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  })) as unknown as typeof fetch;
}

function captureFetch(payload: unknown, status = 200): { url: string; auth: string | null } {
  const seen = { url: "", auth: null as string | null };
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    const headers = init?.headers as Record<string, string> | undefined;
    seen.auth = headers?.["Authorization"] ?? null;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => payload,
    };
  }) as unknown as typeof fetch;
  return seen;
}

describe("fetchNpmMeta", () => {
  test("maps the registry document", async () => {
    stubFetch({
      name: "express",
      version: "5.0.0",
      description: "Fast framework",
      author: { name: "TJ", email: "tj@x.io" },
      license: "MIT",
      repository: { url: "git+https://github.com/expressjs/express.git" },
      dependencies: { accepts: "^1", qs: "^6" },
      maintainers: [{ name: "tj" }, { name: "" }],
    });
    const meta = await fetchNpmMeta("express");
    expect(meta).toMatchObject({
      name: "express",
      version: "5.0.0",
      author: "TJ",
      license: "MIT",
      repoUrl: "https://github.com/expressjs/express",
      directDeps: ["accepts", "qs"],
      maintainers: ["tj"],
    });
  });
  test("tolerates string author, object license, missing repo", async () => {
    stubFetch({
      name: "x",
      version: "1.0.0",
      author: "anon",
      license: { type: "ISC" },
      dependencies: null,
    });
    const meta = await fetchNpmMeta("x");
    expect(meta.author).toBe("anon");
    expect(meta.license).toBe("ISC");
    expect(meta.repoUrl).toBe("n/a");
    expect(meta.directDeps).toEqual([]);
  });
  test("cleans git@ and git:// repo urls", async () => {
    stubFetch({ name: "a", version: "1", repository: "git@github.com:org/repo.git" });
    expect((await fetchNpmMeta("a")).repoUrl).toBe("https://github.com/org/repo");
    stubFetch({ name: "b", version: "1", repository: { url: "git://github.com/org/repo" } });
    expect((await fetchNpmMeta("b")).repoUrl).toBe("https://github.com/org/repo");
  });
  test("404 throws not-found", async () => {
    stubFetch({}, 404);
    await expect(fetchNpmMeta("nope")).rejects.toThrow("not found (//registry.npmjs.org/)");
  });
  test("5xx throws with status", async () => {
    stubFetch({}, 500);
    await expect(fetchNpmMeta("x")).rejects.toThrow("responded 500");
  });
  test("401 hints at auth", async () => {
    stubFetch({}, 401);
    await expect(fetchNpmMeta("priv")).rejects.toThrow(/NPM_TOKEN/);
  });
  test("--registry override changes the request URL", async () => {
    const seen = captureFetch({ name: "x", version: "1.0.0" });
    await fetchNpmMeta("x", { registry: "https://npm.acme.com" });
    expect(seen.url).toBe("https://npm.acme.com/x/latest");
    expect(seen.auth).toBeNull();
  });
  test("NPM_TOKEN is sent as a Bearer header", async () => {
    process.env.NPM_TOKEN = "tok123";
    const seen = captureFetch({ name: "x", version: "1.0.0" });
    await fetchNpmMeta("x");
    expect(seen.url).toBe("https://registry.npmjs.org/x/latest");
    expect(seen.auth).toBe("Bearer tok123");
  });
  test("non-registry names throw before any fetch", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return { status: 200, ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
    await expect(fetchNpmMeta("file:./local")).rejects.toThrow(/invalid package name/);
    await expect(fetchNpmMeta("../escape")).rejects.toThrow(/invalid package name/);
    expect(calls).toBe(0);
  });
});

describe("resolveVersion / specPath", () => {
  const versions = ["3.0.0", "4.0.0", "4.1.2", "5.0.0-beta.1", "5.3.0", "6.0.1"];
  const tags = { latest: "6.0.1", next: "5.0.0-beta.1" };
  test("ranges pick the highest match", () => {
    expect(resolveVersion("4", versions, tags)).toBe("4.1.2");
    expect(resolveVersion("^4.0.0", versions, tags)).toBe("4.1.2");
    expect(resolveVersion("<6", versions, tags)).toBe("5.3.0");
  });
  test("latest wins when it satisfies the range", () => {
    expect(resolveVersion(">=4", versions, { latest: "5.3.0" })).toBe("5.3.0");
  });
  test("dist-tags and exact versions", () => {
    expect(resolveVersion("next", versions, tags)).toBe("5.0.0-beta.1");
    expect(resolveVersion("3.0.0", versions, tags)).toBe("3.0.0");
    expect(resolveVersion("9.9.9", versions, tags)).toBeNull();
  });
  test("no match or nonsense is null", () => {
    expect(resolveVersion("^9", versions, tags)).toBeNull();
    expect(resolveVersion("nope", versions, tags)).toBeNull();
  });
  test("specPath routes latest, direct refs and ranges", () => {
    expect(specPath(null)).toBe("latest");
    expect(specPath("latest")).toBe("latest");
    expect(specPath("1.2.3")).toBe("direct");
    expect(specPath("next")).toBe("direct");
    expect(specPath("4")).toBe("range");
    expect(specPath("^1.2")).toBe("range");
  });
});

describe("fetchNpmMeta with a spec", () => {
  function routed(): string[] {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      urls.push(u);
      if (u === "https://registry.npmjs.org/chalk") {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            "dist-tags": { latest: "6.0.1" },
            versions: { "4.0.0": {}, "4.1.2": {}, "6.0.1": {} },
          }),
        };
      }
      const ref = u.split("/").at(-1)!;
      const ver = ref === "latest" ? "6.0.1" : ref;
      if (!["4.1.2", "6.0.1", "beta"].includes(ver)) {
        return { status: 404, ok: false, json: async () => ({}) };
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ name: "chalk", version: ver === "beta" ? "7.0.0-beta.0" : ver }),
      };
    }) as unknown as typeof fetch;
    return urls;
  }
  test("a range resolves through the packument, then fetches that version", async () => {
    const urls = routed();
    const meta = await fetchNpmMeta("chalk", undefined, "4");
    expect(meta.version).toBe("4.1.2");
    expect(urls).toEqual([
      "https://registry.npmjs.org/chalk",
      "https://registry.npmjs.org/chalk/4.1.2",
    ]);
  });
  test("exact versions and tags go straight to /:pkg/:ref", async () => {
    const urls = routed();
    expect((await fetchNpmMeta("chalk", undefined, "4.1.2")).version).toBe("4.1.2");
    expect((await fetchNpmMeta("chalk", undefined, "beta")).version).toBe("7.0.0-beta.0");
    expect(urls).toEqual([
      "https://registry.npmjs.org/chalk/4.1.2",
      "https://registry.npmjs.org/chalk/beta",
    ]);
  });
  test("specs are cached separately from latest", async () => {
    const urls = routed();
    expect((await fetchNpmMeta("chalk")).version).toBe("6.0.1");
    expect((await fetchNpmMeta("chalk", undefined, "4")).version).toBe("4.1.2");
    expect((await fetchNpmMeta("chalk", undefined, "4")).version).toBe("4.1.2");
    expect(urls.length).toBe(3);
  });
  test("unknown version and unmatched range fail clearly", async () => {
    routed();
    await expect(fetchNpmMeta("chalk", undefined, "9.9.9")).rejects.toThrow(
      '"chalk@9.9.9" not found',
    );
    await expect(fetchNpmMeta("chalk", undefined, "^9")).rejects.toThrow(
      'no version of "chalk" matches "^9"',
    );
  });
});

describe("fetchPublishedAt", () => {
  function packument(body: unknown, status = 200, length?: number): string[] {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return {
        status,
        ok: status < 400,
        headers: { get: (h: string) => (h === "content-length" && length ? String(length) : null) },
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      };
    }) as unknown as typeof fetch;
    return seen;
  }
  test("reads time[version] from the full packument and caches it", async () => {
    const seen = packument({ time: { "1.0.0": "2026-10-21T00:00:00.000Z" } });
    expect(await fetchPublishedAt("x", "1.0.0")).toBe("2026-10-21T00:00:00.000Z");
    expect(await fetchPublishedAt("x", "1.0.0")).toBe("2026-10-21T00:00:00.000Z");
    expect(seen).toEqual(["https://registry.npmjs.org/x"]);
  });
  test("unknown on missing version, bad dates, errors and oversize", async () => {
    packument({ time: { "1.0.0": "garbage" } });
    expect(await fetchPublishedAt("x", "1.0.0")).toBeNull();
    packument({ time: {} });
    expect(await fetchPublishedAt("y", "1.0.0")).toBeNull();
    packument({}, 404);
    expect(await fetchPublishedAt("z", "1.0.0")).toBeNull();
    packument("{}", 200, MAX_PACKUMENT_BYTES + 1);
    expect(await fetchPublishedAt("big", "1.0.0")).toBeNull();
    packument("x".repeat(MAX_PACKUMENT_BYTES + 1));
    expect(await fetchPublishedAt("big2", "1.0.0")).toBeNull();
    packument("not json");
    expect(await fetchPublishedAt("bad", "1.0.0")).toBeNull();
  });
  test("invalid input never fetches", async () => {
    const seen = packument({});
    expect(await fetchPublishedAt("../x", "1.0.0")).toBeNull();
    expect(await fetchPublishedAt("x", "n/a")).toBeNull();
    expect(seen.length).toBe(0);
  });
});
