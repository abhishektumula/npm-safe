import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_FILE,
  clearPmConfigCache,
  isPmEnabled,
  loadPmConfig,
  parsePmConfig,
} from "../src/pmconfig.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nps-pmconfig-"));
  clearPmConfigCache();
});

afterEach(() => {
  clearPmConfigCache();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("parsePmConfig", () => {
  test("structured entries are normalized", () => {
    expect(parsePmConfig({ packageManagers: { brew: { enabled: false }, " Yarn ": { enabled: true } } })).toEqual({
      packageManagers: { brew: { enabled: false }, yarn: { enabled: true } },
    });
  });
  test("non-boolean or non-object entries are ignored (fail-open)", () => {
    expect(
      parsePmConfig({
        packageManagers: {
          brew: { enabled: "no" },
          yarn: "disabled",
          pnpm: null,
          npm: { enabled: 0 },
          bun: {},
        },
      }),
    ).toEqual({ packageManagers: {} });
  });
  test("missing or non-object packageManagers means all enabled", () => {
    expect(parsePmConfig({})).toEqual({ packageManagers: {} });
    expect(parsePmConfig({ packageManagers: ["brew"] })).toEqual({ packageManagers: {} });
    expect(parsePmConfig({ packageManagers: null })).toEqual({ packageManagers: {} });
  });
  test("non-object input means all enabled", () => {
    expect(parsePmConfig(null)).toEqual({ packageManagers: {} });
    expect(parsePmConfig("brew")).toEqual({ packageManagers: {} });
    expect(parsePmConfig([{ enabled: false }])).toEqual({ packageManagers: {} });
  });
  test("unknown names are kept and simply never match", () => {
    expect(parsePmConfig({ packageManagers: { wat: { enabled: false } } })).toEqual({
      packageManagers: { wat: { enabled: false } },
    });
  });
});

describe("loadPmConfig", () => {
  test("reads structured entries from nps.config.json", () => {
    writeFileSync(
      join(dir, CONFIG_FILE),
      JSON.stringify({ packageManagers: { brew: { enabled: false } } }),
    );
    expect(loadPmConfig(dir)).toEqual({ packageManagers: { brew: { enabled: false } } });
  });
  test("missing file means all enabled", () => {
    expect(loadPmConfig(dir)).toEqual({ packageManagers: {} });
  });
  test("malformed JSON fails open to all enabled", () => {
    writeFileSync(join(dir, CONFIG_FILE), "{not json");
    expect(loadPmConfig(dir)).toEqual({ packageManagers: {} });
  });
  test("wrong-shaped JSON fails open to all enabled", () => {
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ packageManagers: 42 }));
    expect(loadPmConfig(dir)).toEqual({ packageManagers: {} });
  });
  test("results are cached per cwd until cleared", () => {
    writeFileSync(
      join(dir, CONFIG_FILE),
      JSON.stringify({ packageManagers: { brew: { enabled: false } } }),
    );
    expect(loadPmConfig(dir)).toEqual({ packageManagers: { brew: { enabled: false } } });
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ packageManagers: {} }));
    expect(loadPmConfig(dir)).toEqual({ packageManagers: { brew: { enabled: false } } });
    clearPmConfigCache();
    expect(loadPmConfig(dir)).toEqual({ packageManagers: {} });
  });
});

describe("isPmEnabled", () => {
  test("enabled unless explicitly disabled, case-insensitive", () => {
    expect(isPmEnabled("brew", { packageManagers: {} })).toBe(true);
    expect(isPmEnabled("brew", { packageManagers: { brew: { enabled: false } } })).toBe(false);
    expect(isPmEnabled("Brew", { packageManagers: { brew: { enabled: false } } })).toBe(false);
    expect(isPmEnabled("brew", { packageManagers: { brew: { enabled: true } } })).toBe(true);
    expect(isPmEnabled("npm", { packageManagers: { brew: { enabled: false } } })).toBe(true);
  });
});
