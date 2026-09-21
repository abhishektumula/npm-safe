import { c, paint } from "./colors.ts";
import { inspectPackages } from "./inspect.ts";
import { confirm } from "./prompt.ts";
import { detectPm, PmError } from "./pm.ts";
import { engineFor, performInstall, performPassthrough, InstallError } from "./install.ts";
import { render } from "./render.ts";
import { sanitizeTerminal } from "./sanitize.ts";
import type { CliOptions, PackageReport } from "./types.ts";

const VERSION = "0.1.0";

export const INSTALL_VERBS = new Set(["install", "i", "add"]);

// First-positional npm commands that are NOT installs — passed straight
// through to the detected package manager with no intel screen.
export const PASSTHROUGH_CMDS = new Set([
  "uninstall",
  "remove",
  "rm",
  "un",
  "update",
  "up",
  "upgrade",
  "run",
  "exec",
  "x",
  "test",
  "run-script",
  "publish",
  "pack",
  "login",
  "logout",
  "whoami",
  "who",
  "view",
  "info",
  "show",
  "list",
  "ls",
  "ll",
  "la",
  "outdated",
  "audit",
  "fund",
  "prune",
  "dedupe",
  "ci",
  "init",
  "create",
  "reinstall",
  "link",
  "unlink",
  "cache",
  "config",
  "set",
  "get",
  "ping",
  "prefix",
  "root",
  "bin",
  "docs",
  "repo",
  "home",
  "explore",
  "edit",
  "rebuild",
  "restart",
  "start",
  "stop",
  "token",
  "profile",
  "team",
  "org",
  "owner",
  "deprecate",
  "dist-tag",
  "hook",
  "star",
  "stars",
  "search",
  "s",
  "se",
  "find",
  "version",
  "pkg",
]);

export type Cmd = "install" | "passthrough";

export interface Parsed {
  cmd: Cmd;
  /** npm subcommand for passthrough (run, test, …); "install" for safe flow */
  subcommand: string;
  /** raw args (after the subcommand) forwarded verbatim to the PM */
  passthroughArgs: string[];
  opts: CliOptions;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): Parsed {
  const opts: CliOptions = {
    packages: [],
    extraArgs: [],
    showAll: false,
    yes: false,
    dev: false,
    peer: false,
    optional: false,
    workspace: null,
    registry: null,
    dryRun: false,
    json: false,
    pmOverride: null,
  };
  let help = false;
  let version = false;
  const positionals: string[] = [];
  // Original-order args minus npms-consumed flags: passthrough must forward
  // verbatim (`run dev --port 3000`, not `run dev 3000 --port`).
  const kept: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      // Everything after -- is forwarded verbatim.
      const rest = argv.slice(i + 1);
      opts.extraArgs.push(...rest);
      kept.push(...rest);
      break;
    } else if (a === "-a" || a === "--all") opts.showAll = true;
    else if (a === "-y" || a === "--yes") opts.yes = true;
    else if (a === "-D" || a === "-d" || a === "--dev" || a === "--save-dev") opts.dev = true;
    else if (a === "-P" || a === "--peer" || a === "--save-peer") opts.peer = true;
    else if (a === "-O" || a === "-o" || a === "--optional" || a === "--save-optional")
      opts.optional = true;
    else if (a === "-w" || a === "--workspace") opts.workspace = argv[++i] ?? null;
    else if (a.startsWith("--workspace=")) opts.workspace = a.slice(12) || null;
    else if (a === "--registry") opts.registry = argv[++i] ?? null;
    else if (a.startsWith("--registry=")) opts.registry = a.slice(11) || null;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") help = true;
    else if (a === "-v" || a === "--version") version = true;
    else if (a === "--pm") opts.pmOverride = argv[++i] ?? null;
    else if (a.startsWith("--pm=")) opts.pmOverride = a.slice(5);
    else if (a.startsWith("-")) {
      opts.extraArgs.push(a);
      kept.push(a);
    } else {
      positionals.push(a);
      kept.push(a);
    }
  }

  const first = positionals[0];
  if (first !== undefined && PASSTHROUGH_CMDS.has(first)) {
    return {
      cmd: "passthrough",
      subcommand: first,
      passthroughArgs: kept.slice(1),
      opts,
      help,
      version,
    };
  }
  // install verb explicit (npms install/i/add …) or bare packages (npms express …)
  const packages =
    first !== undefined && INSTALL_VERBS.has(first) ? positionals.slice(1) : positionals;
  opts.packages = packages;
  return {
    cmd: "install",
    subcommand: "install",
    passthroughArgs: [],
    opts,
    help,
    version,
  };
}

/** `--dev` / `--peer` / `--optional` suffix for installer status lines. */
export function saveFlagsSuffix(o: { dev: boolean; peer: boolean; optional: boolean }): string {
  return `${o.dev ? " --dev" : ""}${o.peer ? " --peer" : ""}${o.optional ? " --optional" : ""}`;
}

/** ` (workspace: api)` suffix for installer status lines, or "" when unset. */
export function workspaceSuffix(o: { workspace: string | null }): string {
  return o.workspace ? ` (workspace: ${o.workspace})` : "";
}

/** ` (registry: host/…)` suffix, or "" when default. Never leaks credentials. */
export function registrySuffix(o: { registry: string | null }): string {
  if (!o.registry) return "";
  return ` (registry: ${o.registry.replace(/\/\/[^/]*@/, "//***@")})`;
}

export function helpText(): string {
  return `
  ${paint(c.pink, "◆ npms")} ${paint(c.dim, `v${VERSION} — npm wrapper with safety intel before you install`)}
  ${paint(c.dim, "Runs on Node ≥18, Bun, and any runtime with fetch + Web APIs.")}

  ${paint(c.cyan, "usage")}
    npms install <pkg...> [flags]     inspect, confirm, then install
    npms install                       install project deps (no intel screen)
    npms i express lodash -a           inspect two packages, full detail
    npms add "express@5" --dry-run     inspect only, install nothing
    npms express lodash -y             bare packages also mean install
    npms add user/repo file:../lib     non-registry specs skip intel + warn
    npms run dev / test / exec …       passthrough to your package manager
    npms uninstall foo                 passthrough, no intel screen

  ${paint(c.cyan, "flags")}
    -a, --all        full detail: direct dep names, transitive sample, license, snyk breakdown
    -y, --yes        skip the [y/N] prompt and install immediately
    -D, --dev        install as devDependency (--save-dev / --dev per PM)
    -P, --peer       install as peerDependency (-P means peer here, not pnpm's -P/prod)
    -O, --optional   install as optionalDependency (both = optional peer)
    -w, --workspace <name>
                     add to a workspace package (pnpm/bun get --filter <name>)
    --registry <url> use a private registry (.npmrc + NPM_TOKEN also work)
    --pm <name>      force package manager: npm | bun | pnpm | yarn | brew
    --dry-run        show intel only, never install
    --json           machine-readable report instead of the color card
    -v, --version    print version
    -h, --help       this help

  ${paint(c.cyan, "notes")}
    3+ packages switch to a compact row: total(direct, transitive), no repo url.
    Bare install (no packages) installs project deps like the manager does.
    Non-registry specs (user/repo, file:, link:, tarball URLs) skip intel
    with a warning and install straight through.
    Manager is auto-detected from local lockfiles (+ packageManager field),
    defaulting to npm. npm/yarn install in-process via their official
    engines (@npmcli/arborist, @yarnpkg/core); pnpm/bun/brew fall back
    to their binaries (no programmatic API exists). -g/--global is rejected
    for the npm/yarn engines (local-project only) — use a binary manager
    or run the global install directly. Unknown flags are forwarded to
    binary installers; the engines map --save-exact/-E plus the -D/-P/-O
    save flags (--peer/-P means peer here: pnpm-native -P is re-emitted
    as --save-peer) and report the rest as ignored. -w/--workspace targets
    one workspace package on every manager (same command, same target);
    --filter stays binary-only and is rejected on the npm/yarn engines.
    Scores under 40/100 (or unavailable health) print a warning first —
    advisory only, npms never blocks.
`;
}

/** Scores below this print a pre-prompt warning. Advisory only: npms informs, never blocks. */
export const LOW_HEALTH_THRESHOLD = 40;

/** Warn about low or unavailable health before the install prompt. */
export function warnOnLowHealth(reports: PackageReport[]): void {
  const low = reports.filter((r) => r.health.score !== null && r.health.score < LOW_HEALTH_THRESHOLD);
  // Unparsable pages get their own louder warning in run(); don't double-report here.
  const unknown = reports.filter((r) => r.health.score === null && !r.health.unparsed);
  if (low.length > 0) {
    const names = low
      .map((r) => `${sanitizeTerminal(r.meta?.name ?? r.query)} (${r.health.score}/100)`)
      .join(", ");
    console.log(paint(c.red, `  ⚠ low health score: ${names} — review before installing`));
  }
  if (unknown.length > 0) {
    const names = unknown.map((r) => sanitizeTerminal(r.meta?.name ?? r.query)).join(", ");
    console.log(paint(c.dim, `  ⚠ health unavailable (snyk unreachable): ${names}`));
  }
}
export async function run(argv: string[]): Promise<void> {
  const { cmd, subcommand, passthroughArgs, opts, help, version } = parseArgs(argv);
  if (version) {
    console.log(VERSION);
    return;
  }

  let pm: string;
  let via: string;
  try {
    ({ pm, via } = detectPm(opts.pmOverride));
  } catch (err) {
    console.error(paint(c.red, `  ✖ ${err instanceof PmError ? err.message : String(err)}`));
    process.exitCode = 1;
    return;
  }

  if (cmd === "passthrough") {
    if (help) {
      console.log(helpText());
      return;
    }
    console.log(paint(c.dim, `  ◈ ${pm} ${subcommand} (via ${via})`));
    try {
      process.exitCode = await performPassthrough(
        pm,
        [subcommand, ...passthroughArgs],
        process.cwd(),
        opts.dryRun,
      );
    } catch (err) {
      console.error(paint(c.red, `  ✖ ${err instanceof InstallError ? err.message : String(err)}`));
      process.exitCode = 1;
    }
    return;
  }

  // -g/--global installs can't run through the in-process engines
  // (Arborist / @yarnpkg/core are local-project only — a silent local
  // install would be worse than an error). Binary managers forward it.
  // Passthrough above is unaffected: it already spawns the real binary.
  const hasGlobalFlag = opts.extraArgs.some((a) => a === "-g" || a === "--global");
  const usesInProcessEngine = pm === "npm" || pm === "yarn";
  if (hasGlobalFlag && usesInProcessEngine) {
    console.error(paint(c.red, `  ✖ -g/--global not supported with ${pm} (in-process engine).`));
    console.error(
      paint(
        c.dim,
        `  Use a binary installer instead: --pm pnpm|bun|brew, or run \`${pm} install -g\` directly.`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  // --dev can't share a dependency field with --peer/--optional anywhere
  // (yarn rejects it outright; Arborist takes a single saveType), so fail
  // here uniformly instead of per-engine divergence.
  if (opts.dev && (opts.peer || opts.optional)) {
    console.error(paint(c.red, "  ✖ cannot combine -D/--dev with -P/--peer or -O/--optional."));
    console.error(paint(c.dim, "  Pick one dependency field per add."));
    process.exitCode = 1;
    return;
  }

  // --filter/-F only exist on the pnpm/bun CLIs. The npm/yarn engines have
  // no such flag, so reject it with the wrapper equivalent instead of
  // silently installing into the wrong manifest.
  const filterFlag = opts.extraArgs.find((a) => a === "--filter" || a === "-F");
  if (filterFlag && usesInProcessEngine) {
    console.error(
      paint(c.red, `  ✖ ${filterFlag} is not supported with ${pm} — use -w/--workspace <name>.`),
    );
    console.error(
      paint(c.dim, "  Or pick a binary manager (--pm pnpm|bun) that speaks --filter natively."),
    );
    process.exitCode = 1;
    return;
  }

  // brew has no workspace concept at all — fail instead of dropping the flag.
  if (opts.workspace && pm === "brew") {
    console.error(paint(c.red, "  ✖ --workspace is not supported with brew (no workspaces)."));
    process.exitCode = 1;
    return;
  }

  // Bare npms install (no packages) -> project install (like npm install)
  if (opts.packages.length === 0) {
    if (help) {
      console.log(helpText());
      return;
    }
    console.log(
      paint(
        c.dim,
        `  ◈ installer: ${pm} via ${engineFor(pm)} (detected: ${via})${saveFlagsSuffix(opts)}${workspaceSuffix(opts)}${registrySuffix(opts)}`,
      ),
    );
    const req = {
      cwd: process.cwd(),
      packages: [],
      dev: opts.dev,
      peer: opts.peer,
      optional: opts.optional,
      workspace: opts.workspace,
      registry: opts.registry,
      extraArgs: opts.extraArgs,
      dryRun: opts.dryRun,
    };
    if (opts.dryRun) {
      const res = await performInstall(pm, req).catch((err) => ({
        ok: false as const,
        message: String(err instanceof InstallError ? err.message : err),
      }));
      console.log(paint(c.dim, `  ◌ ${res.message}`));
      if (!res.ok) process.exitCode = 1;
      return;
    }
    if (!opts.yes && !(await confirm())) {
      console.log(paint(c.dim, "  ◌ aborted. nothing installed."));
      return;
    }
    console.log(paint(c.cyan, `\n  ▶ installing project dependencies via ${engineFor(pm)}\n`));
    try {
      const res = await performInstall(pm, req);
      console.log(paint(c.green, `  ✔ ${res.message}`));
    } catch (err) {
      console.error(paint(c.red, `  ✖ ${err instanceof InstallError ? err.message : String(err)}`));
      process.exitCode = 1;
    }
    return;
  }

  if (help) {
    console.log(helpText());
    return;
  }

  process.stdout.write(paint(c.dim, `  ◌ fetching intel for ${opts.packages.join(", ")} …\n`));
  const reports = await inspectPackages(opts.packages, {
    cwd: process.cwd(),
    registry: opts.registry,
  });

  if (opts.json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    console.log(render(reports, opts.showAll));
  }

  console.log(
    paint(
      c.dim,
      `  ◈ installer: ${pm} via ${engineFor(pm)} (detected: ${via})${saveFlagsSuffix(opts)}${workspaceSuffix(opts)}${registrySuffix(opts)}`,
    ),
  );

  const nonRegistry = reports.filter((r) => r.isNonRegistry);
  if (nonRegistry.length > 0) {
    const specs = nonRegistry.map((r) => r.query).join(", ");
    console.log(paint(c.yellow, `  ⚠ non-registry specs (intel skipped): ${specs}`));
  }

  // Snyk answered but nothing parsed: say so out loud. Fail-open stays
  // (install proceeds), but nobody mistakes it for a clean bill of health.
  const unparsed = reports.filter((r) => r.health.unparsed);
  if (unparsed.length > 0) {
    const specs = unparsed.map((r) => r.query).join(", ");
    console.log(paint(c.yellow, `  ⚠ snyk health unparsable (${specs}) — unknown, not healthy`));
  }

  const registryFailed = reports.filter((r) => !r.isNonRegistry && r.meta === null);
  if (registryFailed.length === reports.length && nonRegistry.length === 0) {
    console.error(paint(c.red, "  ✖ nothing to install — all lookups failed."));
    process.exitCode = 1;
    return;
  }
  warnOnLowHealth(reports.filter((r) => r.meta !== null));
  const installable = reports.filter((r) => r.meta || r.isNonRegistry).map((r) => r.query);
  const req = {
    cwd: process.cwd(),
    packages: installable,
    dev: opts.dev,
    peer: opts.peer,
    optional: opts.optional,
    workspace: opts.workspace,
    registry: opts.registry,
    extraArgs: opts.extraArgs,
    dryRun: opts.dryRun,
  };

  if (opts.dryRun) {
    const res = await performInstall(pm, req).catch((err) => ({
      ok: false as const,
      message: String(err instanceof InstallError ? err.message : err),
    }));
    console.log(paint(c.dim, `  ◌ ${res.message}`));
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (!opts.yes && !(await confirm())) {
    console.log(paint(c.dim, "  ◌ aborted. nothing installed."));
    return;
  }
  console.log(paint(c.cyan, `\n  ▶ installing ${installable.join(", ")} via ${engineFor(pm)}\n`));
  try {
    const res = await performInstall(pm, req);
    console.log(paint(c.green, `  ✔ ${res.message}`));
  } catch (err) {
    console.error(paint(c.red, `  ✖ ${err instanceof InstallError ? err.message : String(err)}`));
    process.exitCode = 1;
  }
}
