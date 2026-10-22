import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearIntelCache, setCache } from "../src/cache.ts";
import {
  clearDepsDevInflight,
  fetchProject,
  repoKeyOf,
  summarizeProject,
  summarizeVersion,
} from "../src/depsdev.ts";

const realFetch = globalThis.fetch;
beforeEach(() => {
  clearIntelCache();
  clearDepsDevInflight();
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const VERSION_DOC = {
  publishedAt: "2021-07-30T12:02:52Z",
  slsaProvenances: [],
  attestations: [
    { verified: true, sourceRepository: "https://github.com/chalk/chalk" },
    { verified: false, sourceRepository: "https://github.com/evil/evil" },
  ],
  relatedProjects: [
    { projectKey: { id: "github.com/chalk/chalk" }, relationType: "ISSUE_TRACKER" },
    { projectKey: { id: "github.com/Chalk/Chalk" }, relationType: "SOURCE_REPO" },
  ],
};
const PROJECT_DOC = {
  starsCount: 23332,
  scorecard: {
    overallScore: 4.6,
    checks: [
      { name: "Maintained", score: 8 },
      { name: "Packaging", score: -1 },
    ],
  },
};

type Route = { status: number; body?: unknown } | Error;
function stub(routes: Record<string, Route>): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const u = String(url);
    seen.push(u);
    const key = Object.keys(routes).find((k) => u.includes(k));
    const r = key ? routes[key]! : { status: 404 };
    if (r instanceof Error) throw r;
    return {
      status: r.status,
      ok: r.status < 400,
      text: async () => JSON.stringify(r.body ?? {}),
    };
  }) as unknown as typeof fetch;
  return seen;
}

describe("repoKeyOf", () => {
  test("normalizes GitHub URLs", () => {
    expect(repoKeyOf("https://github.com/chalk/chalk")).toBe("github.com/chalk/chalk");
    expect(repoKeyOf("git+https://github.com/Org/Repo.git")).toBe("github.com/org/repo");
    expect(repoKeyOf("https://github.com/o/r/tree/main/pkg")).toBe("github.com/o/r");
    expect(repoKeyOf("https://gitlab.com/o/r")).toBeNull();
    expect(repoKeyOf(42)).toBeNull();
  });
});

describe("summarizeVersion / summarizeProject", () => {
  test("keeps publish time, provenance and the source repo", () => {
    expect(summarizeVersion(VERSION_DOC)).toEqual({
      publishedAt: "2021-07-30T12:02:52Z",
      provenance: true,
      repo: "github.com/chalk/chalk",
      repoVerified: true,
    });
  });
  test("unverified claims and empty docs", () => {
    const claimed = summarizeVersion({
      relatedProjects: [{ projectKey: { id: "github.com/react/react" } }],
      slsaProvenances: [{ verified: true, sourceRepository: "https://github.com/me/mine" }],
    });
    expect(claimed.repo).toBe("github.com/react/react");
    expect(claimed.repoVerified).toBe(false);
    expect(summarizeVersion(null)).toEqual({
      publishedAt: null,
      provenance: false,
      repo: null,
      repoVerified: false,
    });
  });
  test("scorecard overall, Maintained check, stars", () => {
    expect(summarizeProject(PROJECT_DOC)).toEqual({ scorecard: 4.6, maintained: 8, stars: 23332 });
    expect(
      summarizeProject({
        scorecard: { overallScore: 99, checks: [{ name: "Maintained", score: -1 }] },
      }),
    ).toEqual({
      scorecard: null,
      maintained: null,
      stars: null,
    });
  });
});

describe("fetchProject", () => {
  test("joins the version and project documents, then caches", async () => {
    const seen = stub({
      "/versions/4.1.2": { status: 200, body: VERSION_DOC },
      "/projects/github.com%2Fchalk%2Fchalk": { status: 200, body: PROJECT_DOC },
    });
    const p = await fetchProject("chalk", "4.1.2");
    expect(p).toMatchObject({ scorecard: 4.6, stars: 23332, provenance: true, maintained: 8 });
    await fetchProject("chalk", "4.1.2");
    expect(seen.length).toBe(2);
  });
  test("scoped names are encoded as one path segment", async () => {
    const seen = stub({});
    expect(await fetchProject("@types/node", "22.0.0")).toBeNull();
    expect(seen[0]).toContain("/packages/%40types%2Fnode/versions/22.0.0");
  });
  test("a failed repo lookup keeps version facts and is not cached", async () => {
    const seen = stub({
      "/versions/": { status: 200, body: VERSION_DOC },
      "/projects/": { status: 500 },
    });
    const p = await fetchProject("chalk", "4.1.2");
    expect(p).toMatchObject({ provenance: true, scorecard: null, stars: null });
    await fetchProject("chalk", "4.1.2");
    expect(seen.filter((u) => u.includes("/versions/")).length).toBe(2);
  });
  test("unindexed repo: no project lookup data", async () => {
    stub({ "/versions/": { status: 200, body: VERSION_DOC } });
    expect((await fetchProject("chalk", "4.1.2"))?.scorecard).toBeNull();
  });
  test("unreachable falls back to stale cache, else null", async () => {
    stub({ "/versions/": new Error("net down") });
    expect(await fetchProject("chalk", "4.1.2")).toBeNull();
    setCache(
      "depsdev:v1:chalk@4.1.2",
      {
        publishedAt: null,
        provenance: false,
        repo: null,
        repoVerified: false,
        scorecard: 5,
        maintained: null,
        stars: null,
      },
      -1000,
    );
    expect(await fetchProject("chalk", "4.1.2")).toMatchObject({ scorecard: 5, stale: true });
  });
  test("invalid names and versions never fetch", async () => {
    const seen = stub({});
    expect(await fetchProject("../x", "1.0.0")).toBeNull();
    expect(await fetchProject("x", "n/a")).toBeNull();
    expect(seen.length).toBe(0);
  });
  test("oversized responses are rejected", async () => {
    globalThis.fetch = (async () => ({
      status: 200,
      ok: true,
      text: async () => "x".repeat(2_000_001),
    })) as unknown as typeof fetch;
    expect(await fetchProject("big", "1.0.0")).toBeNull();
  });
});
