import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPolicyCache,
  effectivePolicy,
  emptyPolicy,
  evaluate,
  isActive,
  loadPolicy,
  parseMinScore,
  parsePolicy,
} from "../src/policy.ts";
import type { PackageReport } from "../src/types.ts";

function report(
  over: Partial<PackageReport> & { license?: string; deprecated?: string | null } = {},
): PackageReport {
  const { license, deprecated, ...rest } = over;
  return {
    query: "pkg",
    meta: {
      name: "pkg",
      version: "1.0.0",
      description: "",
      author: "a",
      license: license ?? "MIT",
      repoUrl: "n/a",
      directDeps: [],
      maintainers: [],
      deprecated: deprecated ?? null,
    },
    metaError: null,
    health: { score: 80, breakdown: null },
    directCount: 0,
    transitiveCount: 0,
    totalCount: 0,
    transitiveNames: [],
    truncated: false,
    elapsedMs: 1,
    ...rest,
  };
}

describe("parsePolicy", () => {
  test("accepts every field", () => {
    const p = parsePolicy({
      policy: {
        minScore: 60,
        blockDeprecated: true,
        blockVulnerabilities: "high",
        allowedLicenses: [" MIT ", "ISC"],
        minWeeklyDownloads: 500,
        minReleaseAgeHours: 72,
      },
    });
    expect(p).toEqual({
      minScore: 60,
      blockDeprecated: true,
      blockVulnerabilities: "high",
      allowedLicenses: ["mit", "isc"],
      minWeeklyDownloads: 500,
      minReleaseAgeHours: 72,
    });
    expect(isActive(p)).toBe(true);
  });
  test("ignores garbage field by field", () => {
    const p = parsePolicy({
      policy: {
        minScore: 101,
        blockDeprecated: "yes",
        blockVulnerabilities: "huge",
        allowedLicenses: [],
        minReleaseAgeHours: -1,
      },
    });
    expect(p).toEqual(emptyPolicy());
    expect(isActive(p)).toBe(false);
  });
  test("non-object inputs are empty", () => {
    for (const raw of [null, 5, [], { policy: [] }, { policy: "x" }]) {
      expect(parsePolicy(raw)).toEqual(emptyPolicy());
    }
  });
});

describe("evaluate", () => {
  test("min-score blocks low and unknown, passes high", () => {
    const pol = { ...emptyPolicy(), minScore: 60 };
    expect(evaluate([report()], pol)).toEqual([]);
    const low = evaluate([report({ health: { score: 30, breakdown: null } })], pol);
    expect(low[0]?.rule).toBe("min-score");
    const unknown = evaluate([report({ health: { score: null, breakdown: null } })], pol);
    expect(unknown[0]?.rule).toBe("health-unknown");
  });
  test("release-age rule blocks fresh versions, unknown passes", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    const pol = { ...emptyPolicy(), minReleaseAgeHours: 72 };
    const fresh = evaluate([report({ publishedAt: "2026-10-22T07:00:00Z" })], pol, now);
    expect(fresh[0]?.rule).toBe("release-age");
    expect(fresh[0]?.message).toBe("pkg@1.0.0: published 5h ago, under minReleaseAgeHours 72");
    expect(evaluate([report({ publishedAt: "2026-01-01T00:00:00Z" })], pol, now)).toEqual([]);
    expect(evaluate([report({ publishedAt: null })], pol, now)).toEqual([]);
    expect(isActive(pol)).toBe(true);
  });
  test("deprecated rule", () => {
    const pol = { ...emptyPolicy(), blockDeprecated: true };
    expect(evaluate([report({ deprecated: "gone" })], pol)[0]?.rule).toBe("deprecated");
    expect(evaluate([report()], pol)).toEqual([]);
  });
  test("vulnerability severity floor; unknown severity always counts", () => {
    const pol = { ...emptyPolicy(), blockVulnerabilities: "high" as const };
    const v = (worst: "low" | "high" | null, count = 1) =>
      report({ vulns: { count, ids: [], worst } });
    expect(evaluate([v("low")], pol)).toEqual([]);
    expect(evaluate([v("high")], pol)[0]?.rule).toBe("vulnerable");
    expect(evaluate([v(null, 2)], pol)[0]?.message).toContain("2 known advisories");
    expect(evaluate([report({ vulns: null })], pol)).toEqual([]);
    expect(evaluate([report({ vulns: { count: 0, ids: [], worst: null } })], pol)).toEqual([]);
  });
  test("license allowlist is case-insensitive and rejects unknown", () => {
    const pol = { ...emptyPolicy(), allowedLicenses: ["mit"] };
    expect(evaluate([report({ license: "MIT" })], pol)).toEqual([]);
    expect(evaluate([report({ license: "GPL-3.0" })], pol)[0]?.rule).toBe("license");
    expect(evaluate([report({ license: "n/a" })], pol)[0]?.rule).toBe("license");
  });
  test("non-registry and failed lookups are skipped", () => {
    const pol = { ...emptyPolicy(), minScore: 99 };
    expect(
      evaluate([report({ isNonRegistry: true, meta: null }), report({ meta: null })], pol),
    ).toEqual([]);
  });
});

describe("loadPolicy", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nps-policy-"));
    clearPolicyCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    clearPolicyCache();
  });
  test("missing file is empty (fail-open)", () => {
    expect(loadPolicy(dir)).toEqual(emptyPolicy());
  });
  test("malformed JSON is empty (fail-open)", () => {
    writeFileSync(join(dir, "nps.config.json"), "{nope");
    expect(loadPolicy(dir)).toEqual(emptyPolicy());
  });
  test("reads file, flag overrides minScore, result is cached", () => {
    writeFileSync(join(dir, "nps.config.json"), JSON.stringify({ policy: { minScore: 50 } }));
    expect(loadPolicy(dir).minScore).toBe(50);
    expect(effectivePolicy(dir, null).minScore).toBe(50);
    expect(effectivePolicy(dir, 70).minScore).toBe(70);
    writeFileSync(join(dir, "nps.config.json"), JSON.stringify({ policy: { minScore: 10 } }));
    expect(loadPolicy(dir).minScore).toBe(50);
  });
});

describe("parseMinScore", () => {
  test("accepts 0–100 integers only", () => {
    expect(parseMinScore("0")).toBe(0);
    expect(parseMinScore("100")).toBe(100);
    expect(parseMinScore("101")).toBeNull();
    expect(parseMinScore("-1")).toBeNull();
    expect(parseMinScore("5.5")).toBeNull();
    expect(parseMinScore("abc")).toBeNull();
    expect(parseMinScore(undefined)).toBeNull();
  });
});
