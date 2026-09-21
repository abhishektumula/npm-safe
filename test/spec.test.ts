import { describe, expect, test } from "bun:test";
import { encodePkg, isValidPkgName, splitSpec } from "../src/spec.ts";

describe("splitSpec", () => {
  test("bare name", () => {
    expect(splitSpec("express")).toEqual({ name: "express", version: null });
  });
  test("name@version", () => {
    expect(splitSpec("express@5")).toEqual({ name: "express", version: "5" });
  });
  test("name@range", () => {
    expect(splitSpec("express@^4.17.1")).toEqual({ name: "express", version: "^4.17.1" });
  });
  test("scoped without version", () => {
    expect(splitSpec("@scope/pkg")).toEqual({ name: "@scope/pkg", version: null });
  });
  test("scoped with version", () => {
    expect(splitSpec("@scope/pkg@1.2.3")).toEqual({ name: "@scope/pkg", version: "1.2.3" });
  });
  test("trailing @ means no version", () => {
    expect(splitSpec("express@")).toEqual({ name: "express", version: null });
    expect(splitSpec("@scope/pkg@")).toEqual({ name: "@scope/pkg", version: null });
  });
  test("empty and whitespace", () => {
    expect(splitSpec("")).toEqual({ name: "", version: null });
    expect(splitSpec("  express@5  ")).toEqual({ name: "express", version: "5" });
  });
  test("lone scope without slash stays whole", () => {
    expect(splitSpec("@scope")).toEqual({ name: "@scope", version: null });
  });
});

describe("encodePkg", () => {
  test("plain name untouched", () => {
    expect(encodePkg("express")).toBe("express");
  });
  test("scoped keeps @ and /", () => {
    expect(encodePkg("@scope/pkg")).toBe("@scope/pkg");
  });
  test("encodes unsafe chars per segment", () => {
    expect(encodePkg("a b")).toBe("a%20b");
    expect(encodePkg("@scope/a+b")).toBe("@scope/a%2Bb");
  });
  test("prevents path traversal via dot segments", () => {
    expect(encodePkg("..")).toBe("%2E%2E");
    expect(encodePkg(".")).toBe("%2E");
    expect(encodePkg("../../foo")).toBe("%2E%2E/%2E%2E/foo");
  });
});

describe("isValidPkgName", () => {
  test("accepts plain and scoped names", () => {
    for (const name of ["express", "left-pad", "a", "@scope/pkg", "@scope/pkg-name.js"]) {
      expect(isValidPkgName(name)).toBe(true);
    }
  });
  test("rejects protocols, paths, and versions smuggled into names", () => {
    for (const name of [
      "file:./local",
      "file:///etc/passwd",
      "git+ssh://git@github.com:org/repo",
      "https://example.com/pkg.tgz",
      "npm:express@5",
      "../escape",
      "..\\escape",
      "/absolute/path",
      "a/b/c",
      "@scope",
      "@/pkg",
      "@scope/",
      "",
      ".hidden",
      "_private",
      "has space",
      "UPPER-ok?",
    ]) {
      expect(isValidPkgName(name)).toBe(false);
    }
  });
  test("rejects empty and overlong names", () => {
    expect(isValidPkgName("")).toBe(false);
    expect(isValidPkgName("a".repeat(215))).toBe(false);
    expect(isValidPkgName("a".repeat(214))).toBe(true);
  });
});
