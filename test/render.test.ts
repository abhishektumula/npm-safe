import { describe, expect, test } from "bun:test";
import { COMPACT_THRESHOLD, render } from "../src/render.ts";
import type { PackageReport } from "../src/types.ts";
import { stripAnsi } from "./helper.ts";

function report(overrides: Partial<PackageReport> = {}): PackageReport {
  return {
    query: "express",
    meta: {
      name: "express",
      version: "5.0.0",
      description: "Fast web framework",
      author: "TJ",
      license: "MIT",
      repoUrl: "https://github.com/expressjs/express",
      directDeps: ["accepts", "qs"],
      maintainers: ["tj"],
    },
    metaError: null,
    health: {
      score: 80,
      breakdown: {
        security: "No known security issues",
        popularity: "Influential project",
        maintenance: "Sustained",
        community: "Active",
      },
    },
    directCount: 2,
    transitiveCount: 3,
    totalCount: 5,
    transitiveNames: ["a", "b", "c"],
    elapsedMs: 42,
    ...overrides,
  };
}

describe("render full card", () => {
  test("shows name, version, author, repo, deps, health", () => {
    const text = stripAnsi(render([report()], false));
    expect(text).toContain("express");
    expect(text).toContain("v5.0.0");
    expect(text).toContain("TJ");
    expect(text).toContain("https://github.com/expressjs/express");
    expect(text).toContain("80/100");
    expect(text).toContain("No known security issues");
  });
  test("failed lookup renders an error row", () => {
    const text = stripAnsi(render([{ ...report(), meta: null, metaError: "not found" }], false));
    expect(text).toContain("express");
    expect(text).toContain("not found");
  });
  test("missing health renders n/a", () => {
    const text = stripAnsi(
      render([{ ...report(), health: { score: null, breakdown: null } }], false),
    );
    expect(text).toContain("n/a");
  });
  test("unrecognized badge text renders dim", () => {
    const r = report();
    r.health.breakdown = {
      security: "Something entirely new",
      popularity: "Something entirely new",
      maintenance: "Something entirely new",
      community: "Something entirely new",
    };
    expect(stripAnsi(render([r], false))).toContain("Something entirely new");
  });
});

describe("render showAll", () => {
  test("adds license, direct names, transitive sample", () => {
    const text = stripAnsi(render([report()], true));
    expect(text).toContain("MIT");
    expect(text).toContain("accepts, qs");
    expect(text).toContain("a, b, c");
  });
  test("truncates long transitive lists", () => {
    const names = Array.from({ length: 40 }, (_, i) => `dep-${i}`);
    const text = stripAnsi(render([{ ...report(), transitiveNames: names }], true));
    expect(text).toContain("+10 more");
  });
  test("empty direct deps render as none", () => {
    const r = report();
    r.meta = { ...r.meta!, directDeps: [] };
    expect(stripAnsi(render([r], true))).toContain("none");
  });
});

describe("render compact rows", () => {
  test(`${COMPACT_THRESHOLD} reports collapse without repo url`, () => {
    const text = stripAnsi(render([report(), report(), report()], false));
    expect(text).toContain("5(2d, 3t)");
    expect(text).not.toContain("https://github.com/expressjs/express");
  });
  test("showAll opts out of compact", () => {
    const text = stripAnsi(render([report(), report(), report()], true));
    expect(text).toContain("https://github.com/expressjs/express");
  });
  test("compact error rows stay visible", () => {
    const text = stripAnsi(
      render([report(), report(), { ...report(), meta: null, metaError: "x" }], false),
    );
    expect(text).toContain("x");
  });
});
