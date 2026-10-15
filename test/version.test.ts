import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/version.ts";

// Single source of truth guard: the CLI version is read from package.json.
describe("version sync", () => {
  test("src/version.ts VERSION matches package.json version", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
  test("cli.ts no longer hardcodes a version literal", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");
    expect(cli).not.toMatch(/const VERSION = "/);
  });
});
