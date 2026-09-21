import { describe, expect, test } from "bun:test";
import { encodePkg, splitSpec, isRegistrySpec, isGitHubShorthand, isLocalSpec } from "../src/spec.ts";

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
});

describe("isRegistrySpec", () => {
  test("registry names return true", () => {
    expect(isRegistrySpec("express")).toBe(true);
    expect(isRegistrySpec("express@5")).toBe(true);
    expect(isRegistrySpec("@scope/pkg")).toBe(true);
    expect(isRegistrySpec("@scope/pkg@1.0.0")).toBe(true);
  });
  test("GitHub shorthand returns false", () => {
    expect(isRegistrySpec("user/repo")).toBe(false);
    expect(isRegistrySpec("user/repo#branch")).toBe(false);
  });
  test("file: returns false", () => {
    expect(isRegistrySpec("file:../local")).toBe(false);
  });
  test("link: returns false", () => {
    expect(isRegistrySpec("link:./local")).toBe(false);
  });
  test("http/https tarball returns false", () => {
    expect(isRegistrySpec("https://example.com/pkg.tgz")).toBe(false);
    expect(isRegistrySpec("http://example.com/pkg.tgz")).toBe(false);
  });
  test("version-pinned non-registry source returns false", () => {
    expect(isRegistrySpec("pkg@file:../lib")).toBe(false);
    expect(isRegistrySpec("pkg@https://example.com/pkg.tgz")).toBe(false);
    expect(isRegistrySpec("@scope/pkg@link:./x")).toBe(false);
  });
  test("versioned registry specs stay true", () => {
    expect(isRegistrySpec("pkg@^1.2.3")).toBe(true);
    expect(isRegistrySpec("@scope/pkg@1.0.0")).toBe(true);
  });
});

describe("isGitHubShorthand", () => {
  test("user/repo returns true", () => {
    expect(isGitHubShorthand("user/repo")).toBe(true);
    expect(isGitHubShorthand("user/repo#main")).toBe(true);
  });
  test("scoped packages return false", () => {
    expect(isGitHubShorthand("@scope/pkg")).toBe(false);
  });
  test("file: returns false", () => {
    expect(isGitHubShorthand("file:../local")).toBe(false);
  });
  test("regular registry names return false", () => {
    expect(isGitHubShorthand("express")).toBe(false);
  });
});

describe("isLocalSpec", () => {
  test("file: returns true", () => {
    expect(isLocalSpec("file:../local")).toBe(true);
  });
  test("link: returns true", () => {
    expect(isLocalSpec("link:./local")).toBe(true);
  });
  test("http/https tarball returns true", () => {
    expect(isLocalSpec("https://example.com/pkg.tgz")).toBe(true);
    expect(isLocalSpec("http://example.com/pkg.tgz")).toBe(true);
  });
  test("regular names return false", () => {
    expect(isLocalSpec("express")).toBe(false);
    expect(isLocalSpec("user/repo")).toBe(false);
  });
});
