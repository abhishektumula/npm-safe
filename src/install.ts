// Install engines — the official per-manager libraries, in-process.
//
//   npm  -> @npmcli/arborist (the npm CLI's own tree engine:
//           buildIdealTree({ add }) + reify())
//   yarn -> @yarnpkg/core (berry's documented Node API: "first and
//           foremost a Node API that can be used programmatically") +
//           plugin-npm for registry resolution + the linker plugin
//           matching the project's nodeLinker (pnp | node-modules).
//           Plugins are pre-registered with Configuration.find (like the
//           yarn CLI) so plugin-provided .yarnrc.yml settings
//           (npmRegistryServer, npmScopes, npmAuthToken) are honored.
//           Bare non-registry specs (user/repo, file:, link:, tarballs)
//           aren't valid yarn descriptors, so those fall back to the
//           yarn binary, which resolves them natively.
//   pnpm / bun / brew -> spawned binary. Neither pnpm (a native binary
//           since v12, no public install API) nor bun (single binary,
//           CLI-only surface) ships a programmatic install API, so the
//           subprocess boundary lives here — behind the same interface,
//           ready to migrate when an API appears.
//
// Nothing outside this file spawns a package manager.

import { spawn } from "node:child_process";
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { fetchNpmMeta } from "./npm.ts";
import { arboristRegistryOpts, loadNpmrc } from "./npmrc.ts";
import { isRegistrySpec } from "./spec.ts";
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

export interface YarnSaveTarget {
  table: "dependencies" | "devDependencies" | "peerDependencies";
  /** ident-level meta to stamp: regular optional dep vs optional peer */
  optionalMeta: "regular" | "peer" | null;
}

/**
 * Map the wrapper save flags to the yarn manifest table (+ meta), mirroring
 * `yarn add`: -P writes peerDependencies, -O marks optionalDependencies
 * (regular) or peerDependenciesMeta.optional (with -P). --dev with
 * --peer/--optional is rejected like the yarn CLI rejects it.
 */
export function yarnTargetFor(o: { dev: boolean; peer: boolean; optional: boolean }): YarnSaveTarget {
  if (o.dev && (o.peer || o.optional)) {
    throw new InstallError("cannot combine --dev with --peer or --optional");
  }
  if (o.peer) return { table: "peerDependencies", optionalMeta: o.optional ? "peer" : null };
  if (o.optional) return { table: "dependencies", optionalMeta: "regular" };
  return { table: o.dev ? "devDependencies" : "dependencies", optionalMeta: null };
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
  const patterns: unknown[] = Array.isArray(raw) ? raw : Array.isArray(raw?.packages) ? raw.packages : [];
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
      return "@yarnpkg/core";
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
      return installWithYarn(req);
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
      return projectInstallWithYarn(req);
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
  let Arborist: new (opts?: Record<string, unknown>) => {
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

// --- yarn: project install ---------------------------------------------------

async function projectInstallWithYarn(req: InstallRequest): Promise<InstallResult> {
  let core: typeof import("@yarnpkg/core");
  try {
    core = await import("@yarnpkg/core");
  } catch {
    throw new InstallError("yarn engine unavailable: @yarnpkg/core is not installed");
  }
  const { Project, StreamReport, Cache } = core;
  const { configuration, portableCwd: cwd } = await loadYarnConfiguration(core, req.cwd);
  // --registry wins over .yarnrc.yml (auth still comes from .yarnrc.yml /
  // environment, which Configuration.find already loaded).
  if (req.registry) applyYarnRegistryOverride(configuration, req.registry, cwd);
  const linker = configuration.get("nodeLinker");

  let findResult: Awaited<ReturnType<typeof Project.find>>;
  try {
    findResult = await Project.find(configuration, cwd);
  } catch (err) {
    throw new InstallError(`no yarn project found under ${req.cwd}: ${errMsg(err)}`);
  }
  const { workspace } = findResult;
  if (!workspace) throw new InstallError(`no yarn workspace found under ${req.cwd}`);
  // Yarn has no workspace-filtered project install (`yarn install` always
  // covers the whole project), so --workspace here would silently do the
  // wrong thing — fail with the way out instead.
  if (req.workspace) {
    throw new InstallError(
      `--workspace "${req.workspace}": yarn cannot filter a project install — omit it or run inside the workspace`,
    );
  }

  if (req.dryRun) {
    return {
      ok: true,
      message: `dry-run: would install project dependencies (linker: ${linker}) — nothing written`,
    };
  }

  const report = await StreamReport.start(
    { configuration, stdout: process.stdout },
    async (report) => {
      const { project } = await Project.find(configuration, cwd);
      const cache = await Cache.find(configuration);
      await project.install({ cache, report });
    },
  );
  if (report.hasErrors()) throw new InstallError("yarn install reported errors (see above)");
  return {
    ok: true,
    message: `installed project dependencies via @yarnpkg/core`,
  };
}

// --- binary: project install -------------------------------------------------

const BINARY_PROJECT_INSTALL_ARGS: Record<string, string[]> = {
  bun: ["install"],
  pnpm: ["install"],
  brew: ["install"],
};

async function projectInstallWithBinary(pm: string, req: InstallRequest): Promise<InstallResult> {
  const baseArgs = BINARY_PROJECT_INSTALL_ARGS[pm];
  if (!baseArgs) throw new InstallError(`unsupported package manager: ${pm}`);
  const wsSuffix = req.workspace ? ` (workspace: ${req.workspace})` : "";
  const registryArgs =
    req.registry && (pm === "pnpm" || pm === "bun") ? ["--registry", req.registry] : [];
  const args = [...baseArgs, ...binaryWorkspaceFlags(pm, req.workspace), ...registryArgs, ...req.extraArgs];
  if (req.dryRun) {
    return { ok: true, message: `dry-run: would run \`${pm} ${args.join(" ")}\` — nothing executed` };
  }
  const code = await spawnPm(pm, args, req.cwd);
  if (code !== 0) throw new InstallError(`${pm} exited with code ${code}`);
  return { ok: true, message: `installed project dependencies via ${pm}${wsSuffix}` };
}

// --- npm: @npmcli/arborist -----------------------------------------------

async function installWithNpm(req: InstallRequest): Promise<InstallResult> {
  let Arborist: new (opts?: Record<string, unknown>) => {
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

// --- yarn: @yarnpkg/core ---------------------------------------------------

type YarnCore = typeof import("@yarnpkg/core");
type YarnProject = Awaited<ReturnType<YarnCore["Project"]["find"]>>["project"];
type YarnWorkspace = Awaited<ReturnType<YarnCore["Project"]["find"]>>["workspace"];
type YarnConfiguration = Awaited<ReturnType<YarnCore["Configuration"]["find"]>>;
type YarnPortablePath = import("@yarnpkg/fslib").PortablePath;

const YARN_ENGINE_PLUGINS = ["@yarnpkg/plugin-npm", "@yarnpkg/plugin-nm", "@yarnpkg/plugin-pnp"];

/**
 * Load the yarn Configuration with the engine plugins pre-registered, so
 * plugin-provided settings in .yarnrc.yml (npmRegistryServer, npmScopes,
 * npmAuthToken — i.e. every private-registry setup) are recognized instead
 * of throwing "Unrecognized configuration setting". Mirrors how the yarn
 * CLI itself feeds its bundled plugins to Configuration.find. `core` is
 * passed in because @yarnpkg/core is lazily imported, never at module load.
 */
export async function loadYarnConfiguration(
  core: YarnCore,
  cwd: string,
): Promise<{ configuration: YarnConfiguration; portableCwd: YarnPortablePath }> {
  const { Configuration } = core;
  const { npath } = await import("@yarnpkg/fslib");
  const portableCwd = npath.toPortablePath(cwd);
  const modules = new Map<string, unknown>();
  for (const name of YARN_ENGINE_PLUGINS) modules.set(name, await import(name));
  // find() activates these itself; activating twice throws (settings exist).
  const configuration = await Configuration.find(portableCwd, {
    modules,
    plugins: new Set<string>(YARN_ENGINE_PLUGINS),
  });
  return { configuration, portableCwd };
}

/**
 * Apply a `--registry` override to a loaded yarn Configuration (CLI flag wins
 * over .yarnrc.yml, like the yarn CLI's own precedence). Auth still comes
 * from the project's .yarnrc.yml / environment, which Configuration.find
 * already loads. Call after activating plugin-npm so the setting is known.
 */
export function applyYarnRegistryOverride(
  configuration: YarnConfiguration,
  registry: string,
  cwd: YarnConfiguration["startingCwd"],
): void {
  configuration.useWithSource("<command line>", { npmRegistryServer: registry }, cwd, {
    overwrite: true,
  });
}

/**
 * Resolve `-w/--workspace <name>` to a project workspace, matching by
 * package name or by path relative to the project root (npm accepts both
 * spellings, so the wrapper does too). structUtils is passed in because
 * @yarnpkg/core is lazily imported by the engine, never at module load.
 */
export function selectYarnWorkspace(
  project: YarnProject,
  name: string,
  structUtils: YarnCore["structUtils"],
): NonNullable<YarnWorkspace> {
  const byName = project.workspaces.find(
    (w) => w.manifest.name && structUtils.stringifyIdent(w.manifest.name) === name,
  );
  if (byName) return byName;
  const byDir = project.workspaces.find((w) => {
    const rel = w.cwd
      .replace(project.cwd, "")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");
    return rel === name.replace(/^\/+/, "").replace(/\/+$/, "");
  });
  if (byDir) return byDir;
  const available = project.workspaces
    .map((w) => (w.manifest.name ? structUtils.stringifyIdent(w.manifest.name) : w.cwd))
    .sort()
    .join(", ");
  throw new InstallError(`--workspace "${name}": no such workspace (available: ${available})`);
}

async function installWithYarn(req: InstallRequest): Promise<InstallResult> {
  // Bare non-registry specs (user/repo, file:, link:, tarball URLs) are not
  // valid yarn descriptors — the yarn CLI itself requires a `name@range`
  // form for those. Delegate the whole command to the yarn binary, which
  // resolves paths/URLs natively (relative paths via name extraction).
  if (req.packages.some((p) => !isRegistrySpec(p))) {
    if (req.workspace) {
      throw new InstallError(
        `--workspace "${req.workspace}": the yarn binary fallback cannot target a workspace — cd into it or use name@range specs`,
      );
    }
    return installWithBinary("yarn", req);
  }
  let core: typeof import("@yarnpkg/core");
  try {
    core = await import("@yarnpkg/core");
  } catch {
    throw new InstallError("yarn engine unavailable: @yarnpkg/core is not installed");
  }
  const { Project, StreamReport, structUtils, Cache } = core;
  if (req.packages.length === 0) throw new InstallError("nothing to install");

  // Engine plugins (registry resolution in plugin-npm, linkers in
  // plugin-pnp / plugin-nm) are registered inside loadYarnConfiguration.
  // The effective linker is then chosen by the project's own config.
  const { configuration, portableCwd: cwd } = await loadYarnConfiguration(core, req.cwd);
  // --registry wins over .yarnrc.yml (auth still comes from .yarnrc.yml /
  // environment, which Configuration.find already loaded).
  if (req.registry) applyYarnRegistryOverride(configuration, req.registry, cwd);
  const linker = configuration.get("nodeLinker");

  let findResult: Awaited<ReturnType<typeof Project.find>>;
  try {
    findResult = await Project.find(configuration, cwd);
  } catch (err) {
    throw new InstallError(`no yarn project found under ${req.cwd}: ${errMsg(err)}`);
  }
  const { project, workspace: nearest } = findResult;
  if (!nearest) throw new InstallError(`no yarn workspace found under ${req.cwd}`);
  // Same flag, same target on every manager: --workspace writes the named
  // workspace's manifest (like `yarn workspace <name> add`) instead of the
  // nearest one.
  const workspace = req.workspace
    ? selectYarnWorkspace(project, req.workspace, structUtils)
    : nearest;
  const wsSuffix = req.workspace ? ` (workspace: ${req.workspace})` : "";

  // Mirror npm semantics: caret default, exact pin on --save-exact/-E.
  const { exact, ignored } = splitExactFlag(req.extraArgs);
  const target = yarnTargetFor(req);

  const targets: Array<ReturnType<typeof structUtils.makeDescriptor>> = [];
  for (const spec of req.packages) {
    let descriptor;
    try {
      descriptor = structUtils.parseDescriptor(spec, false);
    } catch (err) {
      throw new InstallError(`invalid package spec "${spec}": ${errMsg(err)}`);
    }
    if (descriptor.range === "unknown") {
      // Bare name (`left-pad`, `@scope/pkg`): no range to resolve. Default
      // to the latest caret range — same default npm applies — resolved via
      // the registry so typos fail here with a clear error, not mid-install.
      let version: string;
      try {
        version = (
          await fetchNpmMeta(structUtils.stringifyIdent(descriptor), {
            cwd: req.cwd,
            registry: req.registry,
          })
        ).version;
      } catch (err) {
        throw new InstallError(`cannot resolve "${spec}": ${errMsg(err)}`);
      }
      if (!version || version === "n/a")
        throw new InstallError(`cannot resolve "${spec}": no version published`);
      descriptor = structUtils.makeDescriptor(descriptor, exact ? version : `^${version}`);
    }
    targets.push(descriptor);
  }

  if (req.dryRun) {
    const where =
      target.table === "peerDependencies" && target.optionalMeta === "peer"
        ? "peerDependencies (optional)"
        : target.table === "dependencies" && target.optionalMeta === "regular"
          ? "optionalDependencies"
          : target.table;
    return {
      ok: true,
      message: `dry-run: would add ${targets.map((d) => structUtils.stringifyDescriptor(d)).join(", ")} to ${where}${wsSuffix} (linker: ${linker}) — nothing written`,
    };
  }

  // Mirror `yarn add`: write the descriptors into the workspace manifest
  // (nearest, or the --workspace selection), persist package.json, then run
  // the project install.
  // -O on a regular dep lands in optionalDependencies via ident-level
  // dependenciesMeta (how the Manifest round-trips the field); -P -O lands
  // in peerDependencies + peerDependenciesMeta.optional.
  const manifest = workspace.manifest;
  const table = manifest[target.table];
  for (const descriptor of targets) {
    table.set(descriptor.identHash, descriptor);
    if (target.optionalMeta === "regular") {
      const identDescriptor = structUtils.makeDescriptor(descriptor, "unknown");
      Object.assign(manifest.ensureDependencyMeta(identDescriptor), { optional: true });
    } else if (target.optionalMeta === "peer") {
      const identDescriptor = structUtils.makeDescriptor(descriptor, "unknown");
      Object.assign(manifest.ensurePeerDependencyMeta(identDescriptor), { optional: true });
    }
  }
  await workspace.persistManifest();

  const report = await StreamReport.start(
    { configuration, stdout: process.stdout },
    async (report) => {
      const { project } = await Project.find(configuration, cwd);
      const cache = await Cache.find(configuration);
      await project.install({ cache, report });
    },
  );
  if (report.hasErrors()) throw new InstallError("yarn install reported errors (see above)");
  return {
    ok: true,
    message: `installed ${req.packages.join(", ")} via @yarnpkg/core${wsSuffix}${ignored.length ? ` (ignored non-API flags: ${ignored.join(" ")})` : ""}`,
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
  // Fallback target for non-registry specs under --pm yarn (see installWithYarn).
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

async function installWithBinary(pm: string, req: InstallRequest): Promise<InstallResult> {
  const entry = BINARY_INSTALL_ARGS[pm];
  if (!entry) throw new InstallError(`unsupported package manager: ${pm}`);
  if (req.dev && (req.peer || req.optional)) {
    throw new InstallError("cannot combine --dev with --peer or --optional");
  }
  const wsSuffix = req.workspace ? ` (workspace: ${req.workspace})` : "";
  // --registry is native to the pnpm/bun CLIs; the yarn binary has no such
  // flag (its project .yarnrc.yml owns the registry).
  const registryArgs =
    req.registry && (pm === "pnpm" || pm === "bun") ? ["--registry", req.registry] : [];
  const args = [
    ...(req.dev ? entry.dev : entry.normal),
    ...binarySaveFlags(pm, req),
    ...req.packages,
    ...binaryWorkspaceFlags(pm, req.workspace),
    ...registryArgs,
    ...req.extraArgs,
  ];
  if (req.dryRun) {
    return { ok: true, message: `dry-run: would run \`${pm} ${args.join(" ")}\` — nothing executed` };
  }
  const code = await spawnPm(pm, args, req.cwd);
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

function spawnPm(pm: string, args: string[], cwd: string): Promise<number> {
  // Async spawn (not spawnSync): the event loop must keep turning so the
  // dots spinner in cli.ts animates while the child runs. stdio stays
  // inherited, so the child's own progress still paints as before.
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(pm, args, { stdio: "inherit", cwd });
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
