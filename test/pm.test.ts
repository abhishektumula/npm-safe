import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPm } from "../src/pm.ts";

let prevCwd = "";

function chdirTmp(files: Record<string, string> = {}): string {
  prevCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "npms-pm-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  process.chdir(dir);
  return dir;
}

afterEach(() => {
  if (prevCwd) {
    const dir = process.cwd();
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
    prevCwd = "";
  }
});

describe("detectPm", () => {
  test("override wins, lowercased", () => {
    expect(detectPm("YARN")).toEqual({ pm: "yarn", via: "flag --pm" });
  });
  test("lockfile priority: pnpm > yarn > npm > bun", () => {
    const dir = chdirTmp({
      "pnpm-lock.yaml": "",
      "yarn.lock": "",
      "package-lock.json": "",
      "bun.lock": "",
    });
    expect(detectPm(null).pm).toBe("pnpm");
    rmSync(join(dir, "pnpm-lock.yaml"));
    expect(detectPm(null).pm).toBe("yarn");
    rmSync(join(dir, "yarn.lock"));
    expect(detectPm(null).pm).toBe("npm");
    rmSync(join(dir, "package-lock.json"));
    expect(detectPm(null).pm).toBe("bun");
  });
  test("each lockfile maps correctly", () => {
    const cases: Array<[string, string]> = [
      ["pnpm-lock.yaml", "pnpm"],
      ["yarn.lock", "yarn"],
      ["package-lock.json", "npm"],
      ["bun.lock", "bun"],
      ["bun.lockb", "bun"],
    ];
    for (const [file, pm] of cases) {
      chdirTmp({ [file]: "" });
      expect(detectPm(null)).toEqual({ pm, via: expect.any(String) });
      const dir = process.cwd();
      process.chdir(prevCwd);
      rmSync(dir, { recursive: true, force: true });
      prevCwd = "";
    }
  });
  test("packageManager field is the fallback", () => {
    chdirTmp({ "package.json": JSON.stringify({ packageManager: "pnpm@9.0.0" }) });
    expect(detectPm(null)).toEqual({ pm: "pnpm", via: "packageManager field" });
  });
  test("unknown packageManager value falls through to npm", () => {
    chdirTmp({ "package.json": JSON.stringify({ packageManager: "deno@2.0.0" }) });
    expect(detectPm(null)).toEqual({ pm: "npm", via: "default" });
  });
  test("empty dir defaults to npm", () => {
    chdirTmp();
    expect(detectPm(null)).toEqual({ pm: "npm", via: "default" });
  });
});
