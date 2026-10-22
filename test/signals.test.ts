import { describe, expect, test } from "bun:test";
import {
  closest,
  editDistance,
  FRESH_HOURS,
  hoursSince,
  lookalikeOf,
  signalsOf,
} from "../src/signals.ts";
import type { NpmMeta } from "../src/types.ts";

const meta = (over: Partial<NpmMeta>): NpmMeta => ({
  name: "x",
  version: "1.0.0",
  description: "",
  author: "a",
  license: "MIT",
  repoUrl: "n/a",
  directDeps: [],
  maintainers: [],
  ...over,
});

describe("editDistance", () => {
  test("exact, one edit, bounded early-out", () => {
    expect(editDistance("react", "react")).toBe(0);
    expect(editDistance("raect", "react", 2)).toBe(2);
    expect(editDistance("reactt", "react")).toBe(1);
    expect(editDistance("abcdefgh", "react", 2)).toBe(3); // length gap exceeds budget
    expect(editDistance("zzzzz", "react", 2)).toBe(3); // row min exceeds budget
  });
});

describe("lookalikeOf", () => {
  test("flags near-miss of a popular name", () => {
    expect(lookalikeOf("expresss")).toBe("express");
    expect(lookalikeOf("lodsh")).toBe("lodash");
  });
  test("exact popular names and unrelated names are clean", () => {
    expect(lookalikeOf("express")).toBeNull();
    expect(lookalikeOf("totally-unrelated-name")).toBeNull();
  });
  test("short names are skipped (too noisy)", () => {
    expect(lookalikeOf("reac")).toBeNull();
  });
  test("scope is ignored for matching", () => {
    expect(lookalikeOf("@evil/expresss")).toBe("express");
  });
});

describe("signalsOf", () => {
  test("collects deprecated + install scripts", () => {
    const s = signalsOf(
      meta({ name: "plainpkg", deprecated: "use other", installScripts: ["postinstall"] }),
    );
    expect(s).toEqual({
      deprecated: "use other",
      installScripts: ["postinstall"],
      lookalike: null,
      lowDownloads: false,
      freshRelease: false,
      noRepo: true,
    });
  });
  test("defaults when fields are absent (old cache entries)", () => {
    expect(signalsOf(meta({ name: "plainpkg" }))).toEqual({
      deprecated: null,
      installScripts: [],
      lookalike: null,
      lowDownloads: false,
      freshRelease: false,
      noRepo: true,
    });
  });
  test("fresh releases and missing repos", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    const m = meta({ name: "plainpkg", repoUrl: "https://github.com/a/b" });
    expect(signalsOf(m, null, "2026-10-22T00:00:00Z", now).freshRelease).toBe(true);
    expect(signalsOf(m, null, "2026-10-01T00:00:00Z", now).freshRelease).toBe(false);
    expect(signalsOf(m, null, null, now).freshRelease).toBe(false);
    expect(signalsOf(m).noRepo).toBe(false);
    expect(signalsOf(meta({ name: "plainpkg", repoUrl: "" })).noRepo).toBe(true);
  });
  test("hoursSince", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    expect(hoursSince("2026-10-22T00:00:00Z", now)).toBe(12);
    expect(hoursSince("2026-10-23T00:00:00Z", now)).toBe(0);
    expect(hoursSince("nope", now)).toBeNull();
    expect(hoursSince(undefined, now)).toBeNull();
    expect(FRESH_HOURS).toBe(48);
  });
  test("scoped packages never count as lookalikes", () => {
    expect(signalsOf(meta({ name: "@me/expresss" })).lookalike).toBeNull();
  });
});

describe("closest", () => {
  test("suggests a near command, nothing for far words", () => {
    expect(closest("instal", ["install", "uninstall"])).toBe("install");
    expect(closest("banana", ["install", "uninstall"])).toBeNull();
  });
});
