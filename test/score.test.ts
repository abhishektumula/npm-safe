import { describe, expect, test } from "bun:test";
import { estimateHealth } from "../src/score.ts";
import type { Project } from "../src/types.ts";

const now = Date.parse("2026-10-22T00:00:00Z");
const clean = { count: 0, ids: [], worst: null };
const project: Project = {
  publishedAt: "2026-09-01T00:00:00Z",
  provenance: false,
  repo: "github.com/x/y",
  repoVerified: false,
  scorecard: 6,
  maintained: 9,
  stars: 5000,
};

describe("estimateHealth", () => {
  test("healthy popular package scores high with a full breakdown", () => {
    const h = estimateHealth({ vulns: clean, downloads: 5_000_000, project, now })!;
    expect(h.source).toBe("estimate");
    expect(h.score).toBeGreaterThanOrEqual(80);
    expect(h.breakdown).toEqual({
      security: "No known security issues",
      popularity: "Key ecosystem project",
      maintenance: "Healthy",
      community: "Sustainable",
    });
  });
  test("provenance nudges security to 100", () => {
    const a = estimateHealth({ vulns: clean, downloads: 1000, now })!.score!;
    const b = estimateHealth({
      vulns: clean,
      downloads: 1000,
      project: {
        ...project,
        provenance: true,
        scorecard: null,
        stars: null,
        maintained: null,
        publishedAt: null,
      },
      now,
    })!.score!;
    expect(b).toBeGreaterThan(a);
  });
  test("severe advisories cap the total regardless of popularity", () => {
    const crit = estimateHealth({
      vulns: { count: 1, ids: ["X"], worst: "critical" },
      downloads: 9e7,
      project,
      now,
    })!;
    expect(crit.score).toBeLessThanOrEqual(25);
    expect(crit.breakdown?.security).toBe("1 known advisory");
    const high = estimateHealth({
      vulns: { count: 2, ids: [], worst: "high" },
      downloads: 9e7,
      project,
      now,
    })!;
    expect(high.score).toBeLessThanOrEqual(45);
    expect(high.breakdown?.security).toBe("2 known advisories");
    const unknownSev = estimateHealth({
      vulns: { count: 1, ids: [], worst: null },
      downloads: 10,
      now,
    })!;
    expect(unknownSev.score).toBeLessThan(50);
    const low = estimateHealth({
      vulns: { count: 1, ids: [], worst: "low" },
      downloads: 9e7,
      now,
    })!;
    expect(low.score).toBeGreaterThan(80);
  });
  test("deprecation zeroes maintenance and caps the score", () => {
    const h = estimateHealth({ vulns: clean, downloads: 9e7, project, deprecated: "use x", now })!;
    expect(h.score).toBeLessThanOrEqual(40);
    expect(h.breakdown?.maintenance).toBe("Inactive (deprecated)");
  });
  test("without Scorecard, publish age and stars stand in", () => {
    const bare = { ...project, scorecard: null, maintained: null };
    const ages: Array<[string, string]> = [
      ["2026-09-01T00:00:00Z", "Healthy"],
      ["2026-01-01T00:00:00Z", "Healthy"],
      ["2025-01-01T00:00:00Z", "Sustainable"],
      ["2023-06-01T00:00:00Z", "Inactive"],
      ["2015-01-01T00:00:00Z", "Inactive"],
    ];
    for (const [publishedAt, label] of ages) {
      const h = estimateHealth({ vulns: clean, project: { ...bare, publishedAt }, now })!;
      expect(h.breakdown?.maintenance).toBe(label);
    }
    const stars = estimateHealth({ vulns: clean, project: { ...bare, stars: 10 }, now })!;
    expect(stars.breakdown?.community).toBe("Limited");
  });
  test("popularity buckets", () => {
    const pop = (d: number) =>
      estimateHealth({ vulns: clean, downloads: d, now })!.breakdown?.popularity;
    expect(pop(50_000)).toBe("Popular");
    expect(pop(500)).toBe("Limited");
    expect(pop(3)).toBe("Small");
  });
  test("fewer than two known components is not enough evidence", () => {
    expect(estimateHealth({ vulns: clean, now })).toBeNull();
    expect(estimateHealth({ downloads: 1000 })).toBeNull();
    expect(estimateHealth({})).toBeNull();
    const two = estimateHealth({
      vulns: null,
      downloads: 1000,
      project: { ...project, scorecard: null, stars: null },
    })!;
    expect(two.breakdown?.security).toBe("n/a");
  });
});
