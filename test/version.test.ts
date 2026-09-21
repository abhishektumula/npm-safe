import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Single source of truth guard: the CLI banner version must match the
// published package version. If this fails, bump both together.
describe("version sync", () => {
  test("src/cli.ts VERSION matches package.json version", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
      version: string;
    };
    const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");
    const match = cli.match(/const VERSION = "([^"]+)"/);
    expect(match?.[1]).toBe(pkg.version);
  });
});
