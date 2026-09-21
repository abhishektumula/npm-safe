import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  binarySaveFlags,
  engineFor,
  InstallError,
  npmSaveTypeFor,
  performInstall,
  performPassthrough,
  splitExactFlag,
  yarnTargetFor,
} from "../src/install.ts";
import type { InstallRequest } from "../src/types.ts";

function req(overrides: Partial<InstallRequest> = {}): InstallRequest {
  return {
    cwd: process.cwd(),
    packages: ["left-pad"],
    dev: false,
    peer: false,
    optional: false,
    extraArgs: [],
    dryRun: true,
    ...overrides,
  };
}

describe("splitExactFlag", () => {
  test("detects --save-exact and -E, splits the rest", () => {
    expect(splitExactFlag(["--save-exact", "--foo"])).toEqual({ exact: true, ignored: ["--foo"] });
    expect(splitExactFlag(["-E"])).toEqual({ exact: true, ignored: [] });
    expect(splitExactFlag([])).toEqual({ exact: false, ignored: [] });
  });
});

describe("npmSaveTypeFor", () => {
  test("maps each flag to the Arborist saveType", () => {
    expect(npmSaveTypeFor({ dev: false, peer: false, optional: false })).toBe("prod");
    expect(npmSaveTypeFor({ dev: true, peer: false, optional: false })).toBe("dev");
    expect(npmSaveTypeFor({ dev: false, peer: true, optional: false })).toBe("peer");
    expect(npmSaveTypeFor({ dev: false, peer: false, optional: true })).toBe("optional");
    expect(npmSaveTypeFor({ dev: false, peer: true, optional: true })).toBe("peerOptional");
  });
  test("dev with peer/optional throws", () => {
    expect(() => npmSaveTypeFor({ dev: true, peer: true, optional: false })).toThrow(InstallError);
    expect(() => npmSaveTypeFor({ dev: true, peer: false, optional: true })).toThrow(InstallError);
  });
});

describe("yarnTargetFor", () => {
  test("maps each flag to the manifest table", () => {
    expect(yarnTargetFor({ dev: false, peer: false, optional: false })).toEqual({
      table: "dependencies",
      optionalMeta: null,
    });
    expect(yarnTargetFor({ dev: true, peer: false, optional: false })).toEqual({
      table: "devDependencies",
      optionalMeta: null,
    });
    expect(yarnTargetFor({ dev: false, peer: true, optional: false })).toEqual({
      table: "peerDependencies",
      optionalMeta: null,
    });
    expect(yarnTargetFor({ dev: false, peer: false, optional: true })).toEqual({
      table: "dependencies",
      optionalMeta: "regular",
    });
    expect(yarnTargetFor({ dev: false, peer: true, optional: true })).toEqual({
      table: "peerDependencies",
      optionalMeta: "peer",
    });
  });
  test("dev with peer/optional throws", () => {
    expect(() => yarnTargetFor({ dev: true, peer: true, optional: false })).toThrow(InstallError);
  });
});

describe("binarySaveFlags", () => {
  test("re-emits PM-native long forms (never pnpm's -P)", () => {
    expect(binarySaveFlags("pnpm", { dev: false, peer: true, optional: true })).toEqual([
      "--save-peer",
      "--save-optional",
    ]);
    expect(binarySaveFlags("bun", { dev: false, peer: true, optional: true })).toEqual([
      "--peer",
      "--optional",
    ]);
    expect(binarySaveFlags("yarn", { dev: false, peer: true, optional: false })).toEqual([
      "--peer",
    ]);
    expect(binarySaveFlags("brew", { dev: false, peer: true, optional: true })).toEqual([]);
    expect(binarySaveFlags("pnpm", { dev: true, peer: false, optional: false })).toEqual([]);
  });
});

describe("engineFor", () => {
  test("labels every manager", () => {
    expect(engineFor("npm")).toContain("arborist");
    expect(engineFor("yarn")).toContain("core");
    expect(engineFor("pnpm")).toContain("binary");
    expect(engineFor("bun")).toContain("binary");
    expect(engineFor("brew")).toContain("binary");
    expect(engineFor("mystery")).toContain("mystery");
  });
});

describe("InstallError", () => {
  test("carries its name", () => {
    expect(new InstallError("x").name).toBe("InstallError");
  });
});

describe("performInstall guards", () => {
  test("unknown manager throws", async () => {
    await expect(performInstall("wat", req())).rejects.toThrow(InstallError);
  });
  test("empty packages does project install (dry-run)", async () => {
    const res = await performInstall("npm", req({ packages: [], dryRun: true }));
    expect(res.ok).toBe(true);
    expect(res.message).toContain("project dependencies");
  });
});

describe("binary boundary (dry-run only, no spawn)", () => {
  test("bun dry-run prints the would-be command", async () => {
    const res = await performInstall("bun", req());
    expect(res.ok).toBe(true);
    expect(res.message).toContain("bun add left-pad");
  });
  test("yarn delegates non-registry specs to the yarn binary", async () => {
    const res = await performInstall("yarn", req({ packages: ["user/repo"] }));
    expect(res.ok).toBe(true);
    expect(res.message).toContain("yarn add user/repo");
  });
  test("dev + extras shape the command", async () => {
    const res = await performInstall("pnpm", req({ dev: true, extraArgs: ["--foo"] }));
    expect(res.message).toContain("pnpm add --save-dev left-pad --foo");
  });
  test("peer/optional re-emit PM-native flags", async () => {
    const pnpm = await performInstall("pnpm", req({ peer: true, optional: true }));
    expect(pnpm.message).toContain("pnpm add --save-peer --save-optional left-pad");
    const bun = await performInstall("bun", req({ peer: true }));
    expect(bun.message).toContain("bun add --peer left-pad");
    const yarn = await performInstall("yarn", req({ packages: ["user/repo"], optional: true }));
    expect(yarn.message).toContain("yarn add --optional user/repo");
  });
  test("dev with peer/optional throws on binaries too", async () => {
    await expect(performInstall("pnpm", req({ dev: true, peer: true }))).rejects.toThrow(
      /cannot combine/,
    );
  });
});

describe("performPassthrough", () => {
  test("unknown manager throws", async () => {
    await expect(performPassthrough("wat", [], process.cwd(), true)).rejects.toThrow(InstallError);
  });
  test("dry-run returns 0 without spawning", async () => {
    await expect(performPassthrough("npm", ["--version"], process.cwd(), true)).resolves.toBe(0);
  });
  test("real spawn works (harmless --version probe)", async () => {
    await expect(performPassthrough("bun", ["--version"], process.cwd(), false)).resolves.toBe(0);
  });
  test("binary install executes harmless version probes", async () => {
    const res = await performInstall("bun", req({ packages: ["--version"], dryRun: false }));
    expect(res.ok).toBe(true);
  });
});

describe("yarn engine dry-runs (no network: ranged specs only)", () => {
  function yarnDir(withManifest: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), "npms-yarn-"));
    if (withManifest) {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe", version: "0.0.0" }));
    }
    return dir;
  }

  test("ranged spec resolves the plan without touching disk", async () => {
    const dir = yarnDir(true);
    try {
      const res = await performInstall(
        "yarn",
        req({ cwd: dir, packages: ["left-pad@^1"] }),
      );
      expect(res.ok).toBe(true);
      expect(res.message).toContain("would add");
      expect(res.message).toContain("dependencies");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("dev flag targets devDependencies", async () => {
    const dir = yarnDir(true);
    try {
      const res = await performInstall("yarn", req({ cwd: dir, packages: ["a@^1"], dev: true }));
      expect(res.message).toContain("devDependencies");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("peer flag targets peerDependencies", async () => {
    const dir = yarnDir(true);
    try {
      const res = await performInstall("yarn", req({ cwd: dir, packages: ["a@^1"], peer: true }));
      expect(res.message).toContain("peerDependencies");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("optional flag targets optionalDependencies", async () => {
    const dir = yarnDir(true);
    try {
      const res = await performInstall(
        "yarn",
        req({ cwd: dir, packages: ["a@^1"], optional: true }),
      );
      expect(res.message).toContain("optionalDependencies");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("peer + optional targets optional peer", async () => {
    const dir = yarnDir(true);
    try {
      const res = await performInstall(
        "yarn",
        req({ cwd: dir, packages: ["a@^1"], peer: true, optional: true }),
      );
      expect(res.message).toContain("peerDependencies (optional)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("invalid spec fails with a clear error", async () => {
    const dir = yarnDir(true);
    try {
      await expect(performInstall("yarn", req({ cwd: dir, packages: ["@"] }))).rejects.toThrow(
        /invalid package spec/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("directory without a project fails with a clear error", async () => {
    const dir = yarnDir(false);
    try {
      await expect(
        performInstall("yarn", req({ cwd: dir, packages: ["a@^1"] })),
      ).rejects.toThrow(/no yarn project/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
