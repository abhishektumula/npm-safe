import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  binarySaveFlags,
  engineFor,
  InstallError,
  npmSaveTypeFor,
  performInstall,
  performPassthrough,
  resolveNpmWorkspace,
  splitExactFlag,
} from "../src/install.ts";
import type { InstallRequest } from "../src/types.ts";

function req(overrides: Partial<InstallRequest> = {}): InstallRequest {
  return {
    cwd: process.cwd(),
    packages: ["left-pad"],
    dev: false,
    peer: false,
    optional: false,
    workspace: null,
    registry: null,
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

describe("resolveNpmWorkspace", () => {
  function wsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "nps-ws-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "root", version: "0.0.0", workspaces: ["packages/*"] }),
    );
    return dir;
  }
  function addWs(dir: string, rel: string, name: string): void {
    const full = join(dir, rel);
    mkdirSync(full, { recursive: true });
    writeFileSync(join(full, "package.json"), JSON.stringify({ name, version: "0.0.0" }));
  }

  test("matches by package name", () => {
    const dir = wsDir();
    try {
      addWs(dir, "packages/api", "api");
      expect(resolveNpmWorkspace(dir, "api")).toBe("api");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("matches by directory", () => {
    const dir = wsDir();
    try {
      addWs(dir, "packages/api", "api");
      expect(resolveNpmWorkspace(dir, "packages/api")).toBe("api");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("unknown name lists available workspaces", () => {
    const dir = wsDir();
    try {
      addWs(dir, "packages/api", "api");
      expect(() => resolveNpmWorkspace(dir, "nope")).toThrow(/available: api/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("no workspaces field throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "nps-ws-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "solo" }));
      expect(() => resolveNpmWorkspace(dir, "api")).toThrow(/no workspaces defined/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engineFor", () => {
  test("labels every manager", () => {
    expect(engineFor("npm")).toContain("arborist");
    expect(engineFor("yarn")).toContain("binary");
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
    // Empty temp project: resolving the repo's own tree would hit the network.
    const dir = mkdtempSync(join(tmpdir(), "nps-npm-empty-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "probe", version: "0.0.0" }));
      const res = await performInstall("npm", req({ cwd: dir, packages: [], dryRun: true }));
      expect(res.ok).toBe(true);
      expect(res.message).toContain("project dependencies");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
  test("workspace becomes --filter on pnpm/bun", async () => {
    const pnpm = await performInstall("pnpm", req({ workspace: "api" }));
    expect(pnpm.message).toContain("pnpm add left-pad --filter api");
    const bun = await performInstall("bun", req({ workspace: "api" }));
    expect(bun.message).toContain("bun add left-pad --filter api");
  });
  test("registry is re-emitted for pnpm/bun, not yarn", async () => {
    const pnpm = await performInstall("pnpm", req({ registry: "https://r.example.com" }));
    expect(pnpm.message).toContain("pnpm add left-pad --registry https://r.example.com");
    const bun = await performInstall("bun", req({ registry: "https://r.example.com" }));
    expect(bun.message).toContain("bun add left-pad --registry https://r.example.com");
    const yarn = await performInstall(
      "yarn",
      req({ packages: ["user/repo"], registry: "https://r.example.com" }),
    );
    expect(yarn.message).toContain("yarn add user/repo");
    expect(yarn.message).not.toContain("--registry");
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
  test("spawn start failure surfaces cause and cwd", async () => {
    await expect(
      performPassthrough("bun", ["--version"], "/nonexistent-nps-probe-dir", false),
    ).rejects.toThrow(/failed to start `bun`.*\/nonexistent-nps-probe-dir/);
  });
  test("binary install executes harmless version probes", async () => {
    const res = await performInstall("bun", req({ packages: ["--version"], dryRun: false }));
    expect(res.ok).toBe(true);
  });
});

describe("yarn binary dry-runs", () => {
  test("add maps dev/peer/optional to yarn flags", async () => {
    const dev = await performInstall("yarn", req({ packages: ["a@^1"], dev: true }));
    expect(dev.message).toContain("yarn add --dev a@^1");
    const peer = await performInstall("yarn", req({ packages: ["a@^1"], peer: true }));
    expect(peer.message).toContain("yarn add --peer a@^1");
    const both = await performInstall(
      "yarn",
      req({ packages: ["a@^1"], peer: true, optional: true }),
    );
    expect(both.message).toContain("--peer --optional");
  });
  test("workspace uses `yarn workspace <name> add`", async () => {
    const res = await performInstall("yarn", req({ packages: ["a@^1"], workspace: "api" }));
    expect(res.message).toContain("yarn workspace api add a@^1");
  });
  test("--save-exact is translated to --exact", async () => {
    const res = await performInstall(
      "yarn",
      req({ packages: ["a@^1"], extraArgs: ["--save-exact"] }),
    );
    expect(res.message).toContain("--exact");
    expect(res.message).not.toContain("--save-exact");
  });
  test("bare project install runs `yarn install`", async () => {
    const res = await performInstall("yarn", req({ packages: [] }));
    expect(res.message).toContain("yarn install");
  });
  test("workspace on bare project install errors", async () => {
    await expect(performInstall("yarn", req({ packages: [], workspace: "api" }))).rejects.toThrow(
      /cannot filter a project install/,
    );
  });
});
