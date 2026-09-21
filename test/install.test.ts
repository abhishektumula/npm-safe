import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  engineFor,
  InstallError,
  performInstall,
  performPassthrough,
  splitExactFlag,
} from "../src/install.ts";
import type { InstallRequest } from "../src/types.ts";

function req(overrides: Partial<InstallRequest> = {}): InstallRequest {
  return {
    cwd: process.cwd(),
    packages: ["left-pad"],
    dev: false,
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
  test("empty packages throw before any engine loads", async () => {
    await expect(performInstall("npm", req({ packages: [] }))).rejects.toThrow(/nothing to install/);
    await expect(performInstall("yarn", req({ packages: [] }))).rejects.toThrow(
      /nothing to install/,
    );
  });
});

describe("binary boundary (dry-run only, no spawn)", () => {  test("bun dry-run prints the would-be command", async () => {
    const res = await performInstall("bun", req());
    expect(res.ok).toBe(true);
    expect(res.message).toContain("bun add left-pad");
  });
  test("dev + extras shape the command", async () => {
    const res = await performInstall("pnpm", req({ dev: true, extraArgs: ["--foo"] }));
    expect(res.message).toContain("pnpm add --save-dev left-pad --foo");
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
