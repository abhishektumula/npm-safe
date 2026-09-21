import { afterEach, describe, expect, test } from "bun:test";
import { fetchNpmMeta } from "../src/npm.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(payload: unknown, status = 200) {
  globalThis.fetch = (async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  })) as unknown as typeof fetch;
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
    await expect(fetchNpmMeta("nope")).rejects.toThrow('not found on npm');
  });
  test("5xx throws with status", async () => {
    stubFetch({}, 500);
    await expect(fetchNpmMeta("x")).rejects.toThrow("responded 500");
  });
});
