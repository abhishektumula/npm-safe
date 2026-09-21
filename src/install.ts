// Install engines — the official per-manager libraries, in-process.
//
//   npm  -> @npmcli/arborist (the npm CLI's own tree engine:
//           buildIdealTree({ add }) + reify())
//   yarn -> @yarnpkg/core (berry's documented Node API: "first and
//           foremost a Node API that can be used programmatically") +
//           plugin-npm for registry resolution + the linker plugin
//           matching the project's nodeLinker (pnp | node-modules).
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

import { spawnSync } from "node:child_process";
import { fetchNpmMeta } from "./npm.ts";
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

  const arb = new Arborist({ path: req.cwd, save: true, saveType, savePrefix: exact ? "" : "^" });
  try {
    await arb.buildIdealTree({});
  } catch (err) {
    throw new InstallError(`npm resolve failed: ${errMsg(err)}`);
  }

  const resolved = arb.idealTree?.inventory.size;
  if (req.dryRun) {
    return {
      ok: true,
      message: `dry-run: resolved project dependencies${typeof resolved === "number" ? ` (${resolved} nodes in ideal tree)` : ""} — nothing written`,
    };
  }
  try {
    await arb.reify({ save: true });
  } catch (err) {
    throw new InstallError(`npm install failed: ${errMsg(err)}`);
  }
  return {
    ok: true,
    message: `installed project dependencies via @npmcli/arborist${ignored.length ? ` (ignored non-API flags: ${ignored.join(" ")})` : ""}`,
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
  const { Configuration, Project, StreamReport, Cache } = core;
  const { npath } = await import("@yarnpkg/fslib");

  const cwd = npath.toPortablePath(req.cwd);
  const configuration = await Configuration.find(cwd, null);

  const npmPlugin = (await import("@yarnpkg/plugin-npm")).default;
  configuration.activatePlugin("@yarnpkg/plugin-npm", npmPlugin);
  configuration.activatePlugin("@yarnpkg/plugin-nm", (await import("@yarnpkg/plugin-nm")).default);
  configuration.activatePlugin(
    "@yarnpkg/plugin-pnp",
    (await import("@yarnpkg/plugin-pnp")).default,
  );
  const linker = configuration.get("nodeLinker");

  let findResult: Awaited<ReturnType<typeof Project.find>>;
  try {
    findResult = await Project.find(configuration, cwd);
  } catch (err) {
    throw new InstallError(`no yarn project found under ${req.cwd}: ${errMsg(err)}`);
  }
  const { workspace } = findResult;
  if (!workspace) throw new InstallError(`no yarn workspace found under ${req.cwd}`);

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
  const args = [...baseArgs, ...req.extraArgs];
  if (req.dryRun) {
    return { ok: true, message: `dry-run: would run \`${pm} ${args.join(" ")}\` — nothing executed` };
  }
  const code = spawnPm(pm, args, req.cwd);
  if (code !== 0) throw new InstallError(`${pm} exited with code ${code}`);
  return { ok: true, message: `installed project dependencies via ${pm}` };
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

  // savePrefix "" pins the exact version (npm's --save-exact); "^" is npm's default.
  const arb = new Arborist({ path: req.cwd, save: true, saveType, savePrefix: exact ? "" : "^" });
  try {
    await arb.buildIdealTree({ add: req.packages, saveType });
  } catch (err) {
    throw new InstallError(`npm resolve failed: ${errMsg(err)}`);
  }

  const resolved = arb.idealTree?.inventory.size;
  if (req.dryRun) {
    return {
      ok: true,
      message: `dry-run: resolved ${req.packages.join(", ")}${typeof resolved === "number" ? ` (${resolved} nodes in ideal tree)` : ""} — nothing written`,
    };
  }
  try {
    await arb.reify({ save: true });
  } catch (err) {
    throw new InstallError(`npm install failed: ${errMsg(err)}`);
  }
  return {
    ok: true,
    message: `installed ${req.packages.join(", ")} via @npmcli/arborist${ignored.length ? ` (ignored non-API flags: ${ignored.join(" ")})` : ""}`,
  };
}

// --- yarn: @yarnpkg/core ---------------------------------------------------

async function installWithYarn(req: InstallRequest): Promise<InstallResult> {
  // Bare non-registry specs (user/repo, file:, link:, tarball URLs) are not
  // valid yarn descriptors — the yarn CLI itself requires a `name@range`
  // form for those. Delegate the whole command to the yarn binary, which
  // resolves paths/URLs natively (relative paths via name extraction).
  if (req.packages.some((p) => !isRegistrySpec(p))) {
    return installWithBinary("yarn", req);
  }
  let core: typeof import("@yarnpkg/core");
  try {
    core = await import("@yarnpkg/core");
  } catch {
    throw new InstallError("yarn engine unavailable: @yarnpkg/core is not installed");
  }
  const { Configuration, Project, StreamReport, structUtils, Cache } = core;
  const { npath } = await import("@yarnpkg/fslib");
  if (req.packages.length === 0) throw new InstallError("nothing to install");

  const cwd = npath.toPortablePath(req.cwd);
  const configuration = await Configuration.find(cwd, null);

  // Registry resolution (semver ranges, tags) lives in plugin-npm.
  // Linkers live in plugin-pnp / plugin-nm. Like the yarn CLI itself, we
  // activate the full set up front: settings such as `nodeLinker` are
  // contributed by these plugins, so reading config requires them active.
  // The effective linker is then chosen by the project's own config.
  const npmPlugin = (await import("@yarnpkg/plugin-npm")).default;
  configuration.activatePlugin("@yarnpkg/plugin-npm", npmPlugin);
  configuration.activatePlugin("@yarnpkg/plugin-nm", (await import("@yarnpkg/plugin-nm")).default);
  configuration.activatePlugin(
    "@yarnpkg/plugin-pnp",
    (await import("@yarnpkg/plugin-pnp")).default,
  );
  const linker = configuration.get("nodeLinker");

  let findResult: Awaited<ReturnType<typeof Project.find>>;
  try {
    findResult = await Project.find(configuration, cwd);
  } catch (err) {
    throw new InstallError(`no yarn project found under ${req.cwd}: ${errMsg(err)}`);
  }
  const { workspace } = findResult;
  if (!workspace) throw new InstallError(`no yarn workspace found under ${req.cwd}`);

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
        version = (await fetchNpmMeta(structUtils.stringifyIdent(descriptor))).version;
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
      message: `dry-run: would add ${targets.map((d) => structUtils.stringifyDescriptor(d)).join(", ")} to ${where} (linker: ${linker}) — nothing written`,
    };
  }

  // Mirror `yarn add`: write the descriptors into the nearest workspace
  // manifest, persist package.json, then run the project install.
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
    message: `installed ${req.packages.join(", ")} via @yarnpkg/core${ignored.length ? ` (ignored non-API flags: ${ignored.join(" ")})` : ""}`,
  };
}

// --- binary boundary: pnpm / bun / brew ------------------------------------
// No official programmatic install API exists for these managers, so npms
// shells out. Single place, same result type, no shell-string building
// (argv array only — no quoting bugs, no injection).

const BINARY_INSTALL_ARGS: Record<string, { normal: string[]; dev: string[] }> = {
  bun: { normal: ["add"], dev: ["add", "--dev"] },
  pnpm: { normal: ["add"], dev: ["add", "--save-dev"] },
  brew: { normal: ["install"], dev: ["install"] },
  // Fallback target for non-registry specs under --pm yarn (see installWithYarn).
  yarn: { normal: ["add"], dev: ["add", "--dev"] },
};

async function installWithBinary(pm: string, req: InstallRequest): Promise<InstallResult> {
  const entry = BINARY_INSTALL_ARGS[pm];
  if (!entry) throw new InstallError(`unsupported package manager: ${pm}`);
  if (req.dev && (req.peer || req.optional)) {
    throw new InstallError("cannot combine --dev with --peer or --optional");
  }
  const args = [
    ...(req.dev ? entry.dev : entry.normal),
    ...binarySaveFlags(pm, req),
    ...req.packages,
    ...req.extraArgs,
  ];
  if (req.dryRun) {
    return { ok: true, message: `dry-run: would run \`${pm} ${args.join(" ")}\` — nothing executed` };
  }
  const code = spawnPm(pm, args, req.cwd);
  if (code !== 0) throw new InstallError(`${pm} exited with code ${code}`);
  return { ok: true, message: `installed ${req.packages.join(", ")} via ${pm}` };
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

function spawnPm(pm: string, args: string[], cwd: string): number {
  const res = spawnSync(pm, args, { stdio: "inherit", cwd });
  return res.status ?? 1;
}
