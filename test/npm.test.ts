import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fetchNpmMeta, clearNpmInflight } from "../src/npm.ts";
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
