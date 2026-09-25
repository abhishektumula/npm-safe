import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPm, isSupportedPm, PmError, type Pm } from "../src/pm.ts";
import { clearPmConfigCache } from "../src/pmconfig.ts";

let prevCwd = "";

function chdirTmp(files: Record<string, string> = {}): string {
  prevCwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "nps-pm-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  process.chdir(dir);
  return dir;
}

afterEach(() => {
  clearPmConfigCache();
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
    const cases: Array<[string, Pm]> = [
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
  test("unsupported --pm override throws with the allowlist", () => {
    expect(() => detectPm("wat")).toThrow(PmError);
    expect(() => detectPm("wat")).toThrow(/supported: bun, pnpm, npm, yarn, brew/);
  });
  test("override is case-insensitive; brew is flag-only", () => {
    // Isolated temp dir: the repo root's own nps.config.json disables brew.
    chdirTmp();
    expect(detectPm("Bun")).toEqual({ pm: "bun", via: "flag --pm" });
    expect(detectPm("brew")).toEqual({ pm: "brew", via: "flag --pm" });
    expect(isSupportedPm("brew")).toBe(true);
    expect(isSupportedPm("sh")).toBe(false);
  });
  test("disabled manager throws, including via --pm override", () => {
    chdirTmp({ "nps.config.json": JSON.stringify({ packageManagers: { brew: { enabled: false } } }) });
    expect(() => detectPm("brew")).toThrow(PmError);
    expect(() => detectPm("brew")).toThrow(/disabled \(nps\.config\.json/);
    // Enabled managers keep working under the same config.
    expect(detectPm("npm")).toEqual({ pm: "npm", via: "flag --pm" });
  });
  test("disabled manager throws when reached via lockfile detection", () => {
    chdirTmp({
      "yarn.lock": "",
      "nps.config.json": JSON.stringify({ packageManagers: { yarn: { enabled: false } } }),
    });
    expect(() => detectPm(null)).toThrow(/"yarn" is disabled/);
  });
  test("explicit enabled:true keeps the manager routed", () => {
    chdirTmp({
      "nps.config.json": JSON.stringify({ packageManagers: { brew: { enabled: true } } }),
    });
    expect(detectPm("brew")).toEqual({ pm: "brew", via: "flag --pm" });
  });
  test("malformed config fails open to all enabled", () => {
    chdirTmp({ "nps.config.json": "{not json" });
    expect(detectPm("brew")).toEqual({ pm: "brew", via: "flag --pm" });
  });
});
