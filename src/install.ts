// Install engines — the official per-manager libraries, in-process.
//
//   npm  -> @npmcli/arborist (the npm CLI's own tree engine:
//           buildIdealTree({ add }) + reify())
//   yarn -> @yarnpkg/core (berry's documented Node API: "first and
//           foremost a Node API that can be used programmatically") +
//           plugin-npm for registry resolution + the linker plugin
//           matching the project's nodeLinker (pnp | node-modules)
//   pnpm / bun / brew -> spawned binary. Neither pnpm (a native binary
//           since v12, no public install API) nor bun (single binary,
//           CLI-only surface) ships a programmatic install API, so the
//           subprocess boundary lives here — behind the same interface,
//           ready to migrate when an API appears.
//
// Nothing outside this file spawns a package manager.

import { spawnSync } from "node:child_process";
import { fetchNpmMeta } from "./npm.ts";

export interface InstallRequest {
  cwd: string;
  /** original user queries, e.g. ["express@5", "@scope/pkg"] */
  packages: string[];
  dev: boolean;
  /** extras the user passed; known ones are mapped to engine options */
  extraArgs: string[];
  dryRun: boolean;
}

export interface InstallResult {
  ok: boolean;
  message: string;
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

  const exact = req.extraArgs.includes("--save-exact") || req.extraArgs.includes("-E");
  const ignored = req.extraArgs.filter((a) => a !== "--save-exact" && a !== "-E");
  const saveType = req.dev ? "dev" : "prod";

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

  const { workspace } = await Project.find(configuration, cwd);
  if (!workspace) throw new InstallError(`no yarn workspace found under ${req.cwd}`);

  // Mirror npm semantics: caret default, exact pin on --save-exact/-E.
  const exact = req.extraArgs.includes("--save-exact") || req.extraArgs.includes("-E");
  const ignored = req.extraArgs.filter((a) => a !== "--save-exact" && a !== "-E");

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
    const where = req.dev ? "devDependencies" : "dependencies";
    return {
      ok: true,
      message: `dry-run: would add ${targets.map((d) => structUtils.stringifyDescriptor(d)).join(", ")} to ${where} (linker: ${linker}) — nothing written`,
    };
  }

  // Mirror `yarn add`: write the descriptors into the nearest workspace
  // manifest, persist package.json, then run the project install.
  const manifest = workspace.manifest;
  const table = req.dev ? manifest.devDependencies : manifest.dependencies;
  for (const descriptor of targets) table.set(descriptor.identHash, descriptor);
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
};

async function installWithBinary(pm: string, req: InstallRequest): Promise<InstallResult> {
  const entry = BINARY_INSTALL_ARGS[pm];
  if (!entry) throw new InstallError(`unsupported package manager: ${pm}`);
  const args = [...(req.dev ? entry.dev : entry.normal), ...req.packages, ...req.extraArgs];
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
  if (!["bun", "pnpm", "npm", "yarn", "brew"].includes(pm)) {
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
