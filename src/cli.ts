import { c, paint } from "./colors.ts";
import { inspectPackages } from "./inspect.ts";
import { confirm } from "./prompt.ts";
import { detectPm } from "./pm.ts";
import { engineFor, performInstall, performPassthrough, InstallError } from "./install.ts";
import { render } from "./render.ts";
import type { CliOptions } from "./types.ts";

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
    else if (a === "-D" || a === "--dev" || a === "--save-dev") opts.dev = true;
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

export function helpText(): string {
  return `
  ${paint(c.pink, "◆ npms")} ${paint(c.dim, `v${VERSION} — npm wrapper with safety intel before you install`)}
  ${paint(c.dim, "Runs on Node ≥18, Bun, and any runtime with fetch + Web APIs.")}

  ${paint(c.cyan, "usage")}
    npms install <pkg...> [flags]     inspect, confirm, then install
    npms i express lodash -a           inspect two packages, full detail
    npms add "express@5" --dry-run     inspect only, install nothing
    npms express lodash -y             bare packages also mean install
    npms run dev / test / exec …       passthrough to your package manager
    npms uninstall foo                 passthrough, no intel screen

  ${paint(c.cyan, "flags")}
    -a, --all        full detail: direct dep names, transitive sample, license, snyk breakdown
    -y, --yes        skip the [y/N] prompt and install immediately
    -D, --dev        install as devDependency (--save-dev / --dev per PM)
    --pm <name>      force package manager: npm | bun | pnpm | yarn | brew
    --dry-run        show intel only, never install
    --json           machine-readable report instead of the color card
    -v, --version    print version
    -h, --help       this help

  ${paint(c.cyan, "notes")}
    3+ packages switch to a compact row: total(direct, transitive), no repo url.
    Manager is auto-detected from local lockfiles (+ packageManager field),
    defaulting to npm. npm/yarn install in-process via their official
    engines (@npmcli/arborist, @yarnpkg/core); pnpm/bun/brew fall back
    to their binaries (no programmatic API exists). Unknown flags are
    forwarded to binary installers; the engines map --save-exact/-E
    and report the rest as ignored.
`;
}

export async function run(argv: string[]): Promise<void> {
  const { cmd, subcommand, passthroughArgs, opts, help, version } = parseArgs(argv);
  if (version) {
    console.log(VERSION);
    return;
  }

  const { pm, via } = detectPm(opts.pmOverride);

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

  if (help || opts.packages.length === 0) {
    console.log(helpText());
    return;
  }

  process.stdout.write(paint(c.dim, `  ◌ fetching intel for ${opts.packages.join(", ")} …\n`));
  const reports = await inspectPackages(opts.packages);

  if (opts.json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    console.log(render(reports, opts.showAll));
  }

  console.log(
    paint(c.dim, `  ◈ installer: ${pm} via ${engineFor(pm)} (detected: ${via})${opts.dev ? " --dev" : ""}`),
  );

  if (reports.every((r) => r.meta === null)) {
    console.error(paint(c.red, "  ✖ nothing to install — all lookups failed."));
    process.exitCode = 1;
    return;
  }
  const installable = reports.filter((r) => r.meta).map((r) => r.query);
  const req = {
    cwd: process.cwd(),
    packages: installable,
    dev: opts.dev,
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
