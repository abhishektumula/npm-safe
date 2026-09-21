import { spawnSync } from "node:child_process";
import { c, paint } from "./colors.ts";
import { fetchNpmMeta } from "./npm.ts";
import { fetchHealth } from "./snyk.ts";
import { countTransitive } from "./deps.ts";
import { detectPm, installArgs } from "./pm.ts";
import { render } from "./render.ts";
import type { CliOptions, PackageReport } from "./types.ts";

const VERSION = "0.1.0";

export function parseArgs(argv: string[]): { cmd: string; opts: CliOptions; help: boolean; version: boolean } {
  const opts: CliOptions = {
    packages: [],
    showAll: false,
    yes: false,
    dev: false,
    dryRun: false,
    json: false,
    pmOverride: null,
  };
  let cmd = "install";
  let help = false;
  let version = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    else if (a === "-a" || a === "--all") opts.showAll = true;
    else if (a === "-y" || a === "--yes") opts.yes = true;
    else if (a === "-D" || a === "--dev" || a === "--save-dev") opts.dev = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") help = true;
    else if (a === "-v" || a === "--version") version = true;
    else if (a === "--pm") opts.pmOverride = argv[++i] ?? null;
    else if (a.startsWith("--pm=")) opts.pmOverride = a.slice(5);
    else if (["install", "i", "add"].includes(a) && i === 0) cmd = "install";
    else if (a.startsWith("-")) {
      console.error(paint(c.red, `unknown flag: ${a}`));
      help = true;
    } else opts.packages.push(a);
  }
  return { cmd, opts, help, version };
}

export function helpText(): string {
  return `
  ${paint(c.pink, "◆ npm-safe")} ${paint(c.dim, `v${VERSION} — see package intel before you install`)}
  ${paint(c.dim, "Shown in your terminal font (JetBrainsMono / GeistMono Nerd Font friendly).")}

  ${paint(c.cyan, "usage")}
    npm-safe install <pkg...> [flags]     inspect, confirm, then install
    npm-safe i express lodash -a           inspect two packages, full detail
    npm-safe add "express@5" --dry-run     inspect only, install nothing

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
    Manager is auto-detected from local lockfiles only
    (pnpm-lock.yaml, yarn.lock, package-lock.json, bun.lock) — nothing global
    is read or changed.
`;
}

async function inspectOne(query: string): Promise<PackageReport> {
  const t0 = Date.now();
  const base = query.split("@").length > 2 || query.startsWith("@") ? query : query.split("@")[0]!;
  const name = base || query;
  const [metaRes, health] = await Promise.allSettled([fetchNpmMeta(name), fetchHealth(name)]);
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

async function confirm(): Promise<boolean> {
  process.stdout.write(paint(c.yellow, "\n  install these packages? [y/N] "));
  for await (const line of console) {
    const a = line.trim().toLowerCase();
    return a === "y" || a === "yes";
  }
  return false;
}

export async function run(argv: string[]): Promise<void> {
  const { opts, help, version } = parseArgs(argv);
  if (version) {
    console.log(VERSION);
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

  const { pm, via } = detectPm(opts.pmOverride);
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

  if (opts.dryRun) {
    console.log(paint(c.dim, `  ◌ dry-run: would run \`${pm} ${[...args, ...installable].join(" ")}\``));
    return;
  }
  if (!opts.yes && !(await confirm())) {
    console.log(paint(c.dim, "  ◌ aborted. nothing installed."));
    return;
  }
  console.log(paint(c.cyan, `\n  ▶ ${pm} ${[...args, ...installable].join(" ")}\n`));
  const res = spawnSync(pm, [...args, ...installable], { stdio: "inherit" });
  process.exitCode = res.status ?? 1;
}
