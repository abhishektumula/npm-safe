import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { c, paint } from "./colors.ts";
import { fetchNpmMeta } from "./npm.ts";
import { fetchHealth } from "./snyk.ts";
import { countTransitive } from "./deps.ts";
import { detectPm, installArgs } from "./pm.ts";
import { render } from "./render.ts";
import { splitSpec } from "./spec.ts";
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
    dryRun: false,
    json: false,
    pmOverride: null,
  };
  let help = false;
  let version = false;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      // Everything after -- is forwarded verbatim.
      opts.extraArgs.push(...argv.slice(i + 1));
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
    else if (a.startsWith("-")) opts.extraArgs.push(a);
    else positionals.push(a);
  }

  const first = positionals[0];
  if (first !== undefined && PASSTHROUGH_CMDS.has(first)) {
    return {
      cmd: "passthrough",
      subcommand: first,
      passthroughArgs: [...positionals.slice(1), ...opts.extraArgs],
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
    defaulting to npm. Unknown flags are forwarded to the installer.
    (alias: npm-safe still works)
`;
}

async function inspectOne(query: string): Promise<PackageReport> {
  const t0 = Date.now();
  const { name } = splitSpec(query);
  const lookup = name || query;
  const [metaRes, health] = await Promise.allSettled([fetchNpmMeta(lookup), fetchHealth(lookup)]);
  if (metaRes.status === "rejected") {
    return {
      query,
      meta: null,
      metaError: metaRes.reason instanceof Error ? metaRes.reason.message : "fetch failed",
      health: health.status === "fulfilled" ? health.value : { score: null, breakdown: null },
      directCount: 0,
      transitiveCount: 0,
      totalCount: 0,
      transitiveNames: [],
      elapsedMs: Date.now() - t0,
    };
  }
  const meta = metaRes.value;
  const { count, names } = await countTransitive(meta.directDeps);
  return {
    query,
    meta,
    metaError: null,
    health: health.status === "fulfilled" ? health.value : { score: null, breakdown: null },
    directCount: meta.directDeps.length,
    transitiveCount: count,
    totalCount: meta.directDeps.length + count,
    transitiveNames: names,
    elapsedMs: Date.now() - t0,
  };
}

// node:readline — works in Node and Bun. Bun's `for await (console)`
// iterator does not exist in Node, so we never touch Bun.* APIs.
async function confirm(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(paint(c.yellow, "\n  install these packages? [y/N] "), resolve);
    });
    const a = answer.trim().toLowerCase();
    return a === "y" || a === "yes";
  } finally {
    rl.close();
  }
}

function runPm(pm: string, args: string[]): number {
  const res = spawnSync(pm, args, { stdio: "inherit" });
  return res.status ?? 1;
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
    if (opts.dryRun) {
      console.log(paint(c.dim, `  ◌ dry-run: would run \`${pm} ${[subcommand, ...passthroughArgs].join(" ")}\``));
      return;
    }
    process.exitCode = runPm(pm, [subcommand, ...passthroughArgs]);
    return;
  }

  if (help || opts.packages.length === 0) {
    console.log(helpText());
    return;
  }

  process.stdout.write(paint(c.dim, `  ◌ fetching intel for ${opts.packages.join(", ")} …\n`));
  const reports = await Promise.all(opts.packages.map(inspectOne));

  if (opts.json) {
    console.log(JSON.stringify(reports, null, 2));
  } else {
    console.log(render(reports, opts.showAll));
  }

  const args = installArgs(pm, opts.dev);
  if (!args) {
    console.error(paint(c.red, `  ✖ unsupported package manager: ${pm}`));
    process.exitCode = 1;
    return;
  }
  console.log(paint(c.dim, `  ◈ installer: ${pm} (via ${via})${opts.dev ? " --dev" : ""}`));

  if (reports.every((r) => r.meta === null)) {
    console.error(paint(c.red, "  ✖ nothing to install — all lookups failed."));
    process.exitCode = 1;
    return;
  }
  const installable = reports.filter((r) => r.meta).map((r) => r.query);
  const fullArgs = [...args, ...installable, ...opts.extraArgs];

  if (opts.dryRun) {
    console.log(paint(c.dim, `  ◌ dry-run: would run \`${pm} ${fullArgs.join(" ")}\``));
    return;
  }
  if (!opts.yes && !(await confirm())) {
    console.log(paint(c.dim, "  ◌ aborted. nothing installed."));
    return;
  }
  console.log(paint(c.cyan, `\n  ▶ ${pm} ${fullArgs.join(" ")}\n`));
  process.exitCode = runPm(pm, fullArgs);
}
