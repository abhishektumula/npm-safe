import { describe, expect, test } from "bun:test";
import { COMPACT_THRESHOLD, render } from "../src/render.ts";
import { c } from "../src/colors.ts";
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
    truncated: false,
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
    const text = stripAnsi(
      render([{ ...report(), meta: null, metaError: "not found" }], false),
    );
    expect(text).toContain("express");
    expect(text).toContain("not found");
  });
  test("missing health renders n/a", () => {
    const text = stripAnsi(
      render(
        [{ ...report(), health: { score: null, breakdown: null } }],
        false,
      ),
    );
    expect(text).toContain("n/a (snyk unreachable)");
  });
  test("unparsed health renders a parse-failed warning, not plain n/a", () => {
    const text = stripAnsi(
      render(
        [
          {
            ...report(),
            health: { score: null, breakdown: null, unparsed: true },
          },
        ],
        false,
      ),
    );
    expect(text).toContain("n/a (snyk parse failed)");
  });
  test("registry control sequences never reach the terminal", () => {
    const r = report();
    r.meta = {
      ...r.meta!,
      description: "innocent\x1b[2J\x1b[1Afake prompt",
      author: "mallory\x1b]52;c;c3RlYWw=\x07",
      repoUrl: "https://example.com/\u202erepo",
    };
    const raw = render([r], false);
    expect(raw).not.toContain("\x1b[2J");
    expect(raw).not.toContain("\x1b[1A");
    expect(raw).not.toContain("\x1b]52");
    expect(raw).not.toContain("‪");
    expect(raw).not.toContain("‑repo");
    expect(stripAnsi(raw)).toContain("https://example.com/repo");
    expect(stripAnsi(raw)).toContain("innocentfake prompt");
  });
  test("truncated crawls are marked partial", () => {
    const text = stripAnsi(render([{ ...report(), truncated: true }], false));
    expect(text).toContain("partial");
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
    const text = stripAnsi(
      render([{ ...report(), transitiveNames: names }], true),
    );
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
      render(
        [report(), report(), { ...report(), meta: null, metaError: "x" }],
        false,
      ),
    );
    expect(text).toContain("x");
  });
  test("compact rows align deps and health columns for uneven names", () => {
    const short = report();
    const long = report({
      query: "much-longer-name",
      meta: { ...report().meta!, name: "much-longer-name", version: "1.0.0" },
    });
    const rows = stripAnsi(render([short, long, report()], false))
      .split("\n")
      .filter((line) => line.includes("health"));
    expect(rows.length).toBe(3);
    const depIdx = rows.map((line) => line.indexOf("("));
    expect(new Set(depIdx).size).toBe(1);
    const healthIdx = rows.map((line) => line.indexOf("health"));
    expect(new Set(healthIdx).size).toBe(1);
  });
  test("compact rows use a bullet marker, not the diamond", () => {
    const rows = stripAnsi(render([report(), report(), report()], false))
      .split("\n")
      .filter((line) => line.includes("health"));
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row).toContain("•");
      expect(row).not.toContain("◆");
    }
  });
  test("fetched-in timing renders on the card", () => {
    const text = stripAnsi(render([report()], false));
    expect(text).toContain("fetched in 42ms");
  });
  test("long descriptions truncate with an ellipsis, short ones stay whole", () => {
    const r = report();
    r.meta = { ...r.meta!, description: "x".repeat(500) };
    const text = stripAnsi(render([r], false));
    expect(text).toContain("…");
    expect(text).not.toContain("x".repeat(500));
    expect(stripAnsi(render([report()], false))).toContain("Fast web framework");
  });
  test("no dim grey anywhere in cards or rows (readability)", () => {
    const r = report();
    r.health.breakdown = {
      security: "Something entirely new",
      popularity: "Something entirely new",
      maintenance: "Something entirely new",
      community: "Something entirely new",
    };
    const outputs = [
      render([report()], false),
      render([report()], true),
      render([report(), report(), report()], false),
      render([{ ...report(), meta: null, metaError: "x" }], false),
      render([{ ...report(), health: { score: null, breakdown: null } }], false),
      render([r], false),
    ];
    for (const out of outputs) expect(out).not.toContain(c.dim);
  });
});
