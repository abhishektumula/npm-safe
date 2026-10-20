// Install engines — the official per-manager libraries, in-process.
//
//   npm  -> @npmcli/arborist (the npm CLI's own tree engine:
//           buildIdealTree({ add }) + reify())
//   yarn / pnpm / bun / brew -> spawned binary. @yarnpkg/core cannot be
//           installed from npm (it pins `got` with a yarn-only `patch:`
//           spec) and none of these managers ships a stable programmatic
//           install API, so the subprocess boundary lives here — behind
//           the same interface, ready to migrate when an API appears.
//
// Nothing outside this file spawns a package manager.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { arboristRegistryOpts, loadNpmrc } from "./npmrc.ts";
import { ALL_PMS } from "./pm.ts";
import type { InstallRequest, InstallResult } from "./types.ts";

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Split extras into the exact-pin flag (mapped to engine options) and the
 * rest (forwarded to binary installers, reported as ignored by engines).
 */
export function splitExactFlag(extraArgs: string[]): { exact: boolean; ignored: string[] } {
  return {
    exact: extraArgs.includes("--save-exact") || extraArgs.includes("-E"),
    ignored: extraArgs.filter((a) => a !== "--save-exact" && a !== "-E"),
  };
}

export type NpmSaveType = "prod" | "dev" | "optional" | "peer" | "peerOptional";

/**
 * Map the wrapper save flags to Arborist's saveType vocabulary (see the
 * @npmcli/arborist README: prod | optional | dev | peer | peerOptional).
 * --dev with --peer/--optional is rejected at the CLI; this guards direct
 * API use the same way.
 */
export function npmSaveTypeFor(o: { dev: boolean; peer: boolean; optional: boolean }): NpmSaveType {
  if (o.dev && (o.peer || o.optional)) {
    throw new InstallError("cannot combine --dev with --peer or --optional");
  }
  if (o.peer && o.optional) return "peerOptional";
  if (o.peer) return "peer";
  if (o.optional) return "optional";
  return o.dev ? "dev" : "prod";
}

/**
 * PM-native save flags appended for binary installers (which never see the
 * wrapper's canonical -D/-P/-O tokens — pnpm's -P means --save-prod, so the
 * long forms are re-emitted to avoid cross-PM misreads).
 */
export function binarySaveFlags(
  pm: string,
  o: { dev: boolean; peer: boolean; optional: boolean },
): string[] {
  const flags: string[] = [];
  if (pm === "pnpm") {
    if (o.peer) flags.push("--save-peer");
    if (o.optional) flags.push("--save-optional");
  } else if (pm === "bun" || pm === "yarn") {
    if (o.peer) flags.push("--peer");
    if (o.optional) flags.push("--optional");
  }
  return flags;
}

function readJsonFile(path: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  } catch {
    return null;
  }
}

/**
 * Validate `-w/--workspace <name>` against the root package.json workspaces
 * and return the matched workspace *package name* (npm matches by name or
 * by directory, so both spellings work). Only single-level `*` globs are
 * expanded; exotic patterns can't be validated locally, so the name is
 * handed to Arborist untouched (it warns on unknown filters instead of
 * silently installing nowhere).
 */
export function resolveNpmWorkspace(cwd: string, name: string): string {
  const pkg = readJsonFile(join(cwd, "package.json"));
  const raw = pkg?.workspaces;
  const patterns: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.packages)
      ? raw.packages
      : [];
  if (patterns.length === 0) {
    throw new InstallError(`--workspace "${name}": no workspaces defined under ${cwd}`);
  }
  const found = new Map<string, string>(); // package name -> workspace dir
  let expandable = false;
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || pattern.startsWith("!")) continue;
    const star = pattern.indexOf("*");
    if (star === -1) {
      const sub = readJsonFile(join(cwd, pattern, "package.json"));
      if (sub && typeof sub.name === "string") {
        found.set(sub.name, pattern);
        expandable = true;
      }
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (suffix.includes("*") || !/^\/?$/.test(suffix)) continue;
    expandable = true;
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(join(cwd, prefix), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = `${prefix}${e.name}`;
      const sub = readJsonFile(join(cwd, dir, "package.json"));
      if (sub && typeof sub.name === "string") found.set(sub.name, dir);
    }
  }
  for (const [wsName, dir] of found) {
    if (name === wsName || name === dir) return wsName;
  }
  if (!expandable || found.size === 0) return name;
  const available = [...found.keys()].sort().join(", ");
  throw new InstallError(`--workspace "${name}": no such workspace (available: ${available})`);
}

/** Human-readable engine label for status lines. */
export function engineFor(pm: string): string {
  switch (pm) {
    case "npm":
      return "@npmcli/arborist";
    case "yarn":
      return "yarn binary (no programmatic API)";
    case "pnpm":
      return "pnpm binary (no programmatic API)";
    case "bun":
      return "bun binary (no programmatic API)";
    case "brew":
      return "brew binary (no programmatic API)";
    default:
      return `${pm} binary`;
  }
}

export async function performInstall(pm: string, req: InstallRequest): Promise<InstallResult> {
  // If no packages specified, do a project install (install from package.json)
  if (req.packages.length === 0) {
    return performProjectInstall(pm, req);
  }
  switch (pm) {
    case "npm":
      return installWithNpm(req);
    case "yarn":
    case "pnpm":
    case "bun":
    case "brew":
      return installWithBinary(pm, req);
    default:
      throw new InstallError(`unsupported package manager: ${pm}`);
  }
}

// --- project install: install from package.json (no new packages) -------------

async function performProjectInstall(pm: string, req: InstallRequest): Promise<InstallResult> {
  switch (pm) {
    case "npm":
      return projectInstallWithNpm(req);
    case "yarn":
    case "pnpm":
    case "bun":
    case "brew":
      return projectInstallWithBinary(pm, req);
    default:
      throw new InstallError(`unsupported package manager: ${pm}`);
  }
}

// --- npm: project install via arborist reify ---------------------------------

async function projectInstallWithNpm(req: InstallRequest): Promise<InstallResult> {
  let Arborist: new (
    opts?: Record<string, unknown>,
  ) => {
    idealTree?: { inventory: Map<string, unknown> };
    buildIdealTree(opts?: Record<string, unknown>): Promise<unknown>;
    reify(opts?: Record<string, unknown>): Promise<unknown>;
  };
  try {
    ({ default: Arborist } = await import("@npmcli/arborist"));
  } catch {
    throw new InstallError("npm engine unavailable: @npmcli/arborist is not installed");
  }

  const { exact, ignored } = splitExactFlag(req.extraArgs);
  const saveType = req.dev ? "dev" : "prod";
  const ws = req.workspace ? resolveNpmWorkspace(req.cwd, req.workspace) : null;
  const wsSuffix = ws ? ` (workspace: ${ws})` : "";

  const arb = new Arborist({
    path: req.cwd,
    save: true,
    saveType,
    savePrefix: exact ? "" : "^",
    workspaces: ws ? [ws] : [],
    ...arboristRegistryOpts(loadNpmrc(req.cwd), req.registry),
  });
  try {
    await arb.buildIdealTree({});
  } catch (err) {
    throw new InstallError(`npm resolve failed: ${errMsg(err)}`);
  }

  const resolved = arb.idealTree?.inventory.size;
  if (req.dryRun) {
    return {
      ok: true,
      message: `dry-run: resolved project dependencies${typeof resolved === "number" ? ` (${resolved} nodes in ideal tree)` : ""}${wsSuffix} — nothing written`,
    };
  }
  try {
    await arb.reify({ save: true });
  } catch (err) {
    throw new InstallError(`npm install failed: ${errMsg(err)}`);
  }
  return {
    ok: true,
    message: `installed project dependencies via @npmcli/arborist${wsSuffix}${ignored.length ? ` (ignored non-API flags: ${ignored.join(" ")})` : ""}`,
  };
}

// --- binary: project install -------------------------------------------------

const BINARY_PROJECT_INSTALL_ARGS: Record<string, string[]> = {
  yarn: ["install"],
  bun: ["install"],
  pnpm: ["install"],
  brew: ["install"],
};

async function projectInstallWithBinary(pm: string, req: InstallRequest): Promise<InstallResult> {
  const baseArgs = BINARY_PROJECT_INSTALL_ARGS[pm];
  if (!baseArgs) throw new InstallError(`unsupported package manager: ${pm}`);
  // `yarn install` always covers the whole project — silently ignoring
  // --workspace would do the wrong thing, so fail with the way out.
  if (pm === "yarn" && req.workspace) {
    throw new InstallError(
      `--workspace "${req.workspace}": yarn cannot filter a project install — omit it or run inside the workspace`,
    );
  }
  const wsSuffix = req.workspace ? ` (workspace: ${req.workspace})` : "";
  const registryArgs =
    req.registry && (pm === "pnpm" || pm === "bun") ? ["--registry", req.registry] : [];
  const args = [
    ...baseArgs,
    ...binaryWorkspaceFlags(pm, req.workspace),
    ...registryArgs,
    ...yarnExtraArgs(pm, req.extraArgs),
  ];
  if (req.dryRun) {
    return {
      ok: true,
      message: `dry-run: would run \`${pm} ${args.join(" ")}\` — nothing executed`,
    };
  }
  const code = await spawnPm(pm, args, req.cwd, binaryRegistryEnv(pm, req.registry));
  if (code !== 0) throw new InstallError(`${pm} exited with code ${code}`);
  return { ok: true, message: `installed project dependencies via ${pm}${wsSuffix}` };
}

// --- npm: @npmcli/arborist -----------------------------------------------

async function installWithNpm(req: InstallRequest): Promise<InstallResult> {
  let Arborist: new (
    opts?: Record<string, unknown>,
  ) => {
    idealTree?: { inventory: Map<string, unknown> };
    buildIdealTree(opts?: Record<string, unknown>): Promise<unknown>;
    reify(opts?: Record<string, unknown>): Promise<unknown>;
  };
  try {
    ({ default: Arborist } = await import("@npmcli/arborist"));
  } catch {
    throw new InstallError("npm engine unavailable: @npmcli/arborist is not installed");
  }
  if (req.packages.length === 0) throw new InstallError("nothing to install");

  const { exact, ignored } = splitExactFlag(req.extraArgs);
  const saveType = npmSaveTypeFor(req);
  // Same flag, same target on every manager: --workspace selects the
  // workspace node Arborist applies the add to (like `npm --workspace`).
  const ws = req.workspace ? resolveNpmWorkspace(req.cwd, req.workspace) : null;
  const wsSuffix = ws ? ` (workspace: ${ws})` : "";

  // savePrefix "" pins the exact version (npm's --save-exact); "^" is npm's default.
  // Registry + auth ride as flat options (the shape npm layers over .npmrc —
  // Arborist itself never reads .npmrc; pacote consumes these downstream).
  const arb = new Arborist({
    path: req.cwd,
    save: true,
    saveType,
    savePrefix: exact ? "" : "^",
    workspaces: ws ? [ws] : [],
    ...arboristRegistryOpts(loadNpmrc(req.cwd), req.registry),
  });
  try {
    await arb.buildIdealTree({ add: req.packages, saveType });
  } catch (err) {
    throw new InstallError(`npm resolve failed: ${errMsg(err)}`);
  }

  const resolved = arb.idealTree?.inventory.size;
  if (req.dryRun) {
    return {
      ok: true,
      message: `dry-run: resolved ${req.packages.join(", ")}${typeof resolved === "number" ? ` (${resolved} nodes in ideal tree)` : ""}${wsSuffix} — nothing written`,
    };
  }
  try {
    await arb.reify({ save: true });
  } catch (err) {
    throw new InstallError(`npm install failed: ${errMsg(err)}`);
  }
  return {
    ok: true,
    message: `installed ${req.packages.join(", ")} via @npmcli/arborist${wsSuffix}${ignored.length ? ` (ignored non-API flags: ${ignored.join(" ")})` : ""}`,
  };
}

// --- binary boundary: pnpm / bun / brew ------------------------------------
// No official programmatic install API exists for these managers, so nps
// shells out. Single place, same result type, no shell-string building
// (argv array only — no quoting bugs, no injection).

const BINARY_INSTALL_ARGS: Record<string, { normal: string[]; dev: string[] }> = {
  bun: { normal: ["add"], dev: ["add", "--dev"] },
  pnpm: { normal: ["add"], dev: ["add", "--save-dev"] },
  brew: { normal: ["install"], dev: ["install"] },
  yarn: { normal: ["add"], dev: ["add", "--dev"] },
};

/**
 * Workspace targeting for binary installers: pnpm/bun speak `--filter`
 * natively, so the wrapper's `-w/--workspace` is translated (same flag,
 * same target on every manager).
 */
function binaryWorkspaceFlags(pm: string, workspace: string | null): string[] {
  if (!workspace || (pm !== "pnpm" && pm !== "bun")) return [];
  return ["--filter", workspace];
}

/**
 * `--registry` for binaries without a flag: yarn reads it from the
 * environment (berry: YARN_NPM_REGISTRY_SERVER, classic: npm_config_registry),
 * so the override still wins over .yarnrc without touching project files.
 */
function binaryRegistryEnv(pm: string, registry: string | null | undefined): NodeJS.ProcessEnv {
  if (!registry || pm !== "yarn") return {};
  return { YARN_NPM_REGISTRY_SERVER: registry, npm_config_registry: registry };
}

/** yarn spells exact pinning --exact; the wrapper accepts npm's --save-exact. */
function yarnExtraArgs(pm: string, extraArgs: string[]): string[] {
  return pm === "yarn" ? extraArgs.map((a) => (a === "--save-exact" ? "--exact" : a)) : extraArgs;
}

async function installWithBinary(pm: string, req: InstallRequest): Promise<InstallResult> {
  const entry = BINARY_INSTALL_ARGS[pm];
  if (!entry) throw new InstallError(`unsupported package manager: ${pm}`);
  if (req.dev && (req.peer || req.optional)) {
    throw new InstallError("cannot combine --dev with --peer or --optional");
  }
  const wsSuffix = req.workspace ? ` (workspace: ${req.workspace})` : "";
  // --registry is native to the pnpm/bun CLIs; yarn gets it via env.
  const registryArgs =
    req.registry && (pm === "pnpm" || pm === "bun") ? ["--registry", req.registry] : [];
  // yarn targets a workspace with `yarn workspace <name> add …`.
  const yarnWorkspace = pm === "yarn" && req.workspace ? ["workspace", req.workspace] : [];
  const args = [
    ...yarnWorkspace,
    ...(req.dev ? entry.dev : entry.normal),
    ...binarySaveFlags(pm, req),
    ...req.packages,
    ...binaryWorkspaceFlags(pm, req.workspace),
    ...registryArgs,
    ...yarnExtraArgs(pm, req.extraArgs),
  ];
  if (req.dryRun) {
    return {
      ok: true,
      message: `dry-run: would run \`${pm} ${args.join(" ")}\` — nothing executed`,
    };
  }
  const code = await spawnPm(pm, args, req.cwd, binaryRegistryEnv(pm, req.registry));
  if (code !== 0) throw new InstallError(`${pm} exited with code ${code}`);
  return { ok: true, message: `installed ${req.packages.join(", ")} via ${pm}${wsSuffix}` };
}

// --- passthrough: run / test / exec / remove / … ---------------------------
// These are CLI surface with no library equivalent in any manager —
// spawned deliberately, argv only.

export async function performPassthrough(
  pm: string,
  args: string[],
  cwd: string,
  dryRun: boolean,
): Promise<number> {
  if (!(ALL_PMS as readonly string[]).includes(pm)) {
    throw new InstallError(`unsupported package manager: ${pm}`);
  }
  if (dryRun) {
    console.log(`  ◌ dry-run: would run \`${pm} ${args.join(" ")}\` — nothing executed`);
    return 0;
  }
  return spawnPm(pm, args, cwd);
}

function spawnPm(
  pm: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<number> {
  // Async spawn (not spawnSync): the event loop must keep turning so the
  // dots spinner in cli.ts animates while the child runs. stdio stays
  // inherited, so the child's own progress still paints as before.
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(pm, args, { stdio: "inherit", cwd, env: { ...process.env, ...env } });
    } catch (err) {
      reject(new InstallError(`failed to start \`${pm}\` (cwd: ${cwd}): ${errMsg(err)}`));
      return;
    }
    child.on("error", (err) => {
      // ENOENT means "binary missing" or "cwd missing" interchangeably —
      // include both so the cause is diagnosable instead of a bare code.
      reject(new InstallError(`failed to start \`${pm}\` (cwd: ${cwd}): ${errMsg(err)}`));
    });
    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}
