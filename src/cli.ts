import { c, paint, setColorEnabled } from "./colors.ts";
import { VERSION } from "./version.ts";
import { EXIT } from "./exit.ts";
import { setVerbose, vlog } from "./log.ts";
import { runTool, TOOL_CMDS } from "./commands.ts";
import { closest } from "./signals.ts";
import { effectivePolicy, evaluate, parseMinScore, snykEnabled } from "./policy.ts";
import { buildJsonReport } from "./report.ts";
import { inspectPackages } from "./inspect.ts";
import { confirm } from "./prompt.ts";
import { detectPm, PmError } from "./pm.ts";
import { engineFor, performInstall, performPassthrough, InstallError } from "./install.ts";
import { render } from "./render.ts";
import { sanitizeTerminal } from "./sanitize.ts";
import { startSpinner } from "./spinner.ts";
import type { CliOptions, PackageReport } from "./types.ts";

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

export type Cmd = "install" | "passthrough" | "tool";

export interface Parsed {
  cmd: Cmd;
  /** npm subcommand for passthrough (run, test, …); "install" for safe flow */
  subcommand: string;
  /** raw args (after the subcommand) forwarded verbatim to the PM */
  passthroughArgs: string[];
  opts: CliOptions;
  help: boolean;
  version: boolean;
  /** raw --min-score value that failed to parse (0–100 integer), else null */
  minScoreInvalid: string | null;
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
    minScore: null,
    verbose: false,
    noCache: false,
    noColor: false,
    noSnyk: false,
  };
  let help = false;
  let version = false;
  let minScoreInvalid: string | null = null;
  const positionals: string[] = [];
  // Original-order args minus nps-consumed flags: passthrough must forward
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
    else if (a === "--verbose") {
      opts.verbose = true;
      kept.push(a);
    } else if (a === "--no-cache") {
      opts.noCache = true;
      kept.push(a);
    } else if (a === "--no-snyk") {
      opts.noSnyk = true;
      kept.push(a);
    } else if (a === "--no-color") {
      opts.noColor = true;
      kept.push(a);
    } else if (a === "--min-score" || a.startsWith("--min-score=")) {
      const raw = a === "--min-score" ? argv[++i] : a.slice(12);
      opts.minScore = parseMinScore(raw);
      if (opts.minScore === null) minScoreInvalid = raw ?? "";
      kept.push(a, ...(a === "--min-score" && raw !== undefined ? [raw] : []));
    } else if (a === "-h" || a === "--help") help = true;
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
  if (first !== undefined && TOOL_CMDS.has(first)) {
    return {
      cmd: "tool",
      subcommand: first,
      passthroughArgs: kept.slice(1),
      opts,
      help,
      version,
      minScoreInvalid,
    };
  }
  if (first !== undefined && PASSTHROUGH_CMDS.has(first)) {
    return {
      cmd: "passthrough",
      subcommand: first,
      passthroughArgs: kept.slice(1),
      opts,
      help,
      version,
      minScoreInvalid,
    };
  }
  // `nps check <pkg…>` = inspect only: the install flow with --dry-run forced.
  const isCheck = first === "check";
  if (isCheck) opts.dryRun = true;
  // install verb explicit (nps install/i/add …) or bare packages (nps express …)
  const packages =
    first !== undefined && (INSTALL_VERBS.has(first) || first === "check")
      ? positionals.slice(1)
      : positionals;
  opts.packages = packages;
  return {
    cmd: "install",
    subcommand: isCheck ? "check" : "install",
    passthroughArgs: [],
    opts,
    help,
    version,
    minScoreInvalid,
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
  ${paint(c.pink, "◆ nps")} ${paint(c.dim, `v${VERSION} — npm wrapper with safety intel before you install`)}
  ${paint(c.dim, "Runs on Node ≥20.17, Bun, and any runtime with fetch + Web APIs.")}

  ${paint(c.cyan, "usage")}
    nps install <pkg...> [flags]     inspect, confirm, then install
    nps install                       install project deps (no intel screen)
    nps i express lodash -a           inspect two packages, full detail
    nps check express                 inspect only, never installs (= --dry-run)
    nps scan [--prod]                 screen this project's declared dependencies
    nps doctor                        check manager detection, registry, snyk, osv, cache
    nps cache-clear                   delete nps's intel cache
    nps completions <bash|zsh|fish>   print a shell completion script
    nps alias                         print handy shell aliases
    nps add "express@5" --dry-run     inspect only, install nothing
    nps express lodash -y             bare packages also mean install
    nps add user/repo file:../lib     non-registry specs skip intel + warn
    nps run dev / test / exec …       passthrough to your package manager
    nps uninstall foo                 passthrough, no intel screen

  ${paint(c.cyan, "flags")}
    -a, --all        full detail: direct dep names, transitive sample, license, snyk breakdown
    -y, --yes        skip the [y/N] prompt and install immediately
    -D, --dev        install as devDependency (--save-dev / --dev per PM)
    -P, --peer       install as peerDependency (-P means peer here, not pnpm's -P/prod)
    -O, --optional   install as optionalDependency (both = optional peer)
    -E, --save-exact pin the exact version instead of a ^range
    -w, --workspace <name>
                     add to a workspace package (pnpm/bun get --filter <name>)
    --registry <url> use a private registry (.npmrc + NPM_TOKEN also work)
    --pm <name>      force package manager: npm | bun | pnpm | yarn | brew
    --min-score <n>  block (exit 3) when snyk health is below n/100 or unknown
    --dry-run        show intel only, never install
    --json           machine-readable report (schemaVersion 1); never prompts
    --verbose        diagnostics on stderr: detection, cache, timings, ignored flags
    --no-cache       skip the intel cache for this run
    --no-snyk        skip the Snyk health scrape (config: "sources": { "snyk": false })
    --no-color       plain output (NO_COLOR is honored; pipes are plain automatically)
    -v, --version    print version
    -h, --help       this help

  ${paint(c.cyan, "exit codes")}
    0 ok (also: you declined the prompt)   1 error   3 blocked by policy
    4 intel unavailable (every lookup failed)

  ${paint(c.cyan, "notes")}
    3+ packages switch to a compact row: total(direct, transitive), no repo url.
    Intel = registry metadata + snyk health + OSV advisories + local signals
    (deprecated, install scripts, name close to a popular package).
    Bare install (no packages) installs project deps like the manager does.
    Non-registry specs (user/repo, file:, link:, tarball URLs) skip intel
    with a warning and install straight through.
    Manager is auto-detected from local lockfiles (+ packageManager field),
    defaulting to npm. npm installs in-process via its official engine
    (@npmcli/arborist); yarn/pnpm/bun/brew run their own binaries.
    -g/--global is rejected for npm/yarn (local-project only) — use pnpm,
    bun or brew, or run the global install directly. Unknown flags are forwarded to
    binary installers; the engines map --save-exact/-E plus the -D/-P/-O
    save flags (--peer/-P means peer here: pnpm-native -P is re-emitted
    as --save-peer) and report the rest as ignored. -w/--workspace targets
    one workspace package on every manager (same command, same target);
    --filter stays binary-only and is rejected on the npm/yarn engines.
    Scores under 40/100 (or unavailable health) print a warning first —
    advisory unless a policy is set. nps.config.json:
      { "packageManagers": { "<name>": { "enabled": false } },
        "policy": { "minScore": 60, "blockDeprecated": true,
                    "blockVulnerabilities": "high",
                    "allowedLicenses": ["MIT", "ISC"] } }
    Policy violations exit 3 and -y does not bypass them.
`;
}

/** Scores below this print a pre-prompt warning. Advisory only: nps informs, never blocks. */
export const LOW_HEALTH_THRESHOLD = 40;

/** Warn about low or unavailable health before the install prompt. */
export function warnOnLowHealth(
  reports: PackageReport[],
  out: (line: string) => void = console.log,
): void {
  const low = reports.filter(
    (r) => r.health.score !== null && r.health.score < LOW_HEALTH_THRESHOLD,
  );
  // Unparsable pages get their own louder warning in run(); don't double-report here.
  const unknown = reports.filter(
    (r) => r.health.score === null && !r.health.unparsed && !r.health.skipped,
  );
  if (low.length > 0) {
    const names = low
      .map((r) => `${sanitizeTerminal(r.meta?.name ?? r.query)} (${r.health.score}/100)`)
      .join(", ");
    out(paint(c.red, `  ⚠ low health score: ${names} — review before installing`));
  }
  if (unknown.length > 0) {
    const names = unknown.map((r) => sanitizeTerminal(r.meta?.name ?? r.query)).join(", ");
    out(paint(c.dim, `  ⚠ health unavailable (snyk unreachable): ${names}`));
  }
}

/** Command words a mistyped package name might actually have meant. */
function commandWords(): string[] {
  return [...INSTALL_VERBS, ...PASSTHROUGH_CMDS, ...TOOL_CMDS, "check"].filter(
    (w) => w.length >= 4,
  );
}

export async function run(argv: string[]): Promise<void> {
  const { cmd, subcommand, passthroughArgs, opts, help, version, minScoreInvalid } =
    parseArgs(argv);
  if (version) {
    console.log(VERSION);
    return;
  }

  // Process-wide switches first so every later line honors them.
  setVerbose(opts.verbose);
  if (opts.noCache) process.env.NPS_NO_CACHE = "1";
  // NO_COLOR is honored inside paint(); piped stdout is handled by index.ts.
  if (opts.noColor) setColorEnabled(false);

  if (minScoreInvalid !== null) {
    console.error(
      paint(
        c.red,
        `  ✖ --min-score needs an integer 0–100 (got "${sanitizeTerminal(minScoreInvalid)}").`,
      ),
    );
    process.exitCode = EXIT.ERROR;
    return;
  }

  if (cmd === "tool") {
    if (help) {
      console.log(helpText());
      return;
    }
    process.exitCode = await runTool(subcommand, passthroughArgs, opts);
    return;
  }

  let pm: string;
  let via: string;
  try {
    ({ pm, via } = detectPm(opts.pmOverride));
  } catch (err) {
    console.error(paint(c.red, `  ✖ ${err instanceof PmError ? err.message : String(err)}`));
    process.exitCode = EXIT.ERROR;
    return;
  }
  vlog(`package manager: ${pm} (detected: ${via}), engine: ${engineFor(pm)}`);

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
      process.exitCode = EXIT.ERROR;
    }
    return;
  }

  // -g/--global installs can't run through the in-process engines
  // (Arborist is local-project only — a silent local install would be
  // worse than an error), and yarn's global add isn't `add -g`. The other
  // binary managers forward it.
  // Passthrough above is unaffected: it already spawns the real binary.
  const hasGlobalFlag = opts.extraArgs.some((a) => a === "-g" || a === "--global");
  const usesInProcessEngine = pm === "npm";
  if (hasGlobalFlag && (usesInProcessEngine || pm === "yarn")) {
    console.error(paint(c.red, `  ✖ -g/--global not supported with ${pm}.`));
    console.error(
      paint(
        c.dim,
        `  Use a binary installer instead: --pm pnpm|bun|brew, or run \`${pm} install -g\` directly.`,
      ),
    );
    process.exitCode = EXIT.ERROR;
    return;
  }

  // --dev can't share a dependency field with --peer/--optional anywhere
  // (yarn rejects it outright; Arborist takes a single saveType), so fail
  // here uniformly instead of per-engine divergence.
  if (opts.dev && (opts.peer || opts.optional)) {
    console.error(paint(c.red, "  ✖ cannot combine -D/--dev with -P/--peer or -O/--optional."));
    console.error(paint(c.dim, "  Pick one dependency field per add."));
    process.exitCode = EXIT.ERROR;
    return;
  }

  // --filter/-F only exist on the pnpm/bun CLIs. npm and yarn have
  // no such flag, so reject it with the wrapper equivalent instead of
  // silently installing into the wrong manifest.
  const filterFlag = opts.extraArgs.find((a) => a === "--filter" || a === "-F");
  if (filterFlag && (usesInProcessEngine || pm === "yarn")) {
    console.error(
      paint(c.red, `  ✖ ${filterFlag} is not supported with ${pm} — use -w/--workspace <name>.`),
    );
    console.error(
      paint(c.dim, "  Or pick a binary manager (--pm pnpm|bun) that speaks --filter natively."),
    );
    process.exitCode = EXIT.ERROR;
    return;
  }

  // brew has no workspace concept at all — fail instead of dropping the flag.
  if (opts.workspace && pm === "brew") {
    console.error(paint(c.red, "  ✖ --workspace is not supported with brew (no workspaces)."));
    process.exitCode = EXIT.ERROR;
    return;
  }

  // Flags the in-process engines cannot honor: say so before any work, not after.
  if (usesInProcessEngine) {
    const ignored = opts.extraArgs.filter((a) => a !== "--save-exact" && a !== "-E");
    if (ignored.length > 0) vlog(`ignored by the ${pm} engine: ${ignored.join(" ")}`);
  }

  // Bare nps install (no packages) -> project install (like npm install)
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
      if (!res.ok) process.exitCode = EXIT.ERROR;
      return;
    }
    if (!opts.yes && !(await confirm())) {
      console.log(paint(c.dim, abortMessage()));
      return;
    }
    // Dots spinner while the engine works — Arborist is silent, so the old
    // static `▶` line felt frozen on slow installs.
    const spinner = startSpinner(`installing project dependencies via ${engineFor(pm)}`);
    try {
      const res = await performInstall(pm, req);
      spinner.succeed(res.message);
    } catch (err) {
      spinner.fail(err instanceof InstallError ? err.message : String(err));
      process.exitCode = EXIT.ERROR;
    }
    return;
  }

  if (help) {
    console.log(helpText());
    return;
  }

  // --json keeps stdout machine-readable: every human line goes to stderr.
  const say = (line: string): void => (opts.json ? console.error(line) : console.log(line));

  // Animated dots while registry + snyk + dep crawl run — the old static
  // line felt frozen on slow networks. --json stays silent (machine-readable).
  const noSnyk = opts.noSnyk || !snykEnabled(process.cwd());
  let reports: PackageReport[];
  if (opts.json) {
    reports = await inspectPackages(opts.packages, {
      cwd: process.cwd(),
      registry: opts.registry,
      noSnyk,
    });
  } else {
    const spinner = startSpinner(`fetching intel for ${opts.packages.join(", ")}`);
    try {
      reports = await inspectPackages(opts.packages, {
        cwd: process.cwd(),
        registry: opts.registry,
        noSnyk,
      });
    } finally {
      spinner.stop();
    }
  }

  const policy = effectivePolicy(process.cwd(), opts.minScore);
  const violations = evaluate(reports, policy);

  if (opts.json) {
    console.log(
      JSON.stringify(
        buildJsonReport(subcommand === "check" ? "check" : "install", reports, policy, violations),
        null,
        2,
      ),
    );
  } else {
    console.log(render(reports, opts.showAll));
  }

  say(
    paint(
      c.dim,
      `  ◈ installer: ${pm} via ${engineFor(pm)} (detected: ${via})${saveFlagsSuffix(opts)}${workspaceSuffix(opts)}${registrySuffix(opts)}`,
    ),
  );

  const nonRegistry = reports.filter((r) => r.isNonRegistry);
  if (nonRegistry.length > 0) {
    const specs = nonRegistry.map((r) => r.query).join(", ");
    say(paint(c.yellow, `  ⚠ non-registry specs (intel skipped): ${specs}`));
  }

  // Snyk answered but nothing parsed: say so out loud. Fail-open stays
  // (install proceeds), but nobody mistakes it for a clean bill of health.
  const unparsed = reports.filter((r) => r.health.unparsed);
  if (unparsed.length > 0) {
    const specs = unparsed.map((r) => r.query).join(", ");
    say(paint(c.yellow, `  ⚠ snyk health unparsable (${specs}) — unknown, not healthy`));
  }

  const registryFailed = reports.filter((r) => !r.isNonRegistry && r.meta === null);
  if (registryFailed.length === reports.length && nonRegistry.length === 0) {
    console.error(paint(c.red, "  ✖ nothing to install — all lookups failed."));
    for (const r of registryFailed) {
      const hint = closest(r.query, commandWords());
      if (hint) console.error(paint(c.dim, `  did you mean \`nps ${hint}\`?`));
    }
    process.exitCode = EXIT.UNAVAILABLE;
    return;
  }
  warnOnLowHealth(
    reports.filter((r) => r.meta !== null),
    say,
  );

  // Policy gate: runs before the dry-run/prompt split so `nps check` works as
  // a CI gate, and -y can never wave a violation through.
  if (violations.length > 0) {
    console.error(paint(c.red, `  ✖ blocked by policy (${violations.length}):`));
    for (const v of violations) console.error(paint(c.red, `    - ${sanitizeTerminal(v.message)}`));
    console.error(
      paint(c.dim, "  Loosen --min-score / nps.config.json policy to proceed. Nothing installed."),
    );
    process.exitCode = EXIT.BLOCKED;
    return;
  }

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
    say(paint(c.dim, `  ◌ ${res.message}`));
    if (!res.ok) process.exitCode = EXIT.ERROR;
    return;
  }
  // --json is non-interactive: it reports, and only installs when -y says so.
  if (opts.json && !opts.yes) return;
  if (!opts.yes && !(await confirm())) {
    say(paint(c.dim, abortMessage()));
    return;
  }
  // Dots spinner while the engine works — same frozen-static-line problem as
  // the intel wait above. Succeed/fail lines carry the engine's message.
  const spinner = startSpinner(`installing ${installable.join(", ")} via ${engineFor(pm)}`);
  try {
    const res = await performInstall(pm, req);
    spinner.succeed(res.message);
  } catch (err) {
    spinner.fail(err instanceof InstallError ? err.message : String(err));
    process.exitCode = EXIT.ERROR;
  }
}

/** Declined vs. non-interactive: the second needs a hint, or CI logs look like a silent no-op. */
function abortMessage(): string {
  return process.stdin.isTTY
    ? "  ◌ aborted. nothing installed."
    : "  ◌ aborted: not an interactive terminal. nothing installed (pass -y to install).";
}
