// nps-native commands that are not installs: scan, doctor, cache-clear,
// completions, alias. cli.ts routes here; keep each command small and
// side-effect-light (only cache-clear deletes anything, and only nps's own cache).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { c, paint } from "./colors.ts";
import { aliasSnippet, completionScript, SHELLS, type Shell } from "./completions.ts";
import { cacheStats, purgeIntelCache } from "./cache.ts";
import { EXIT } from "./exit.ts";
import { fetchWithRetry } from "./fetch.ts";
import { inspectPackages } from "./inspect.ts";
import { detectPm, PmError } from "./pm.ts";
import { CONFIG_FILE } from "./pmconfig.ts";
import { effectivePolicy, evaluate, isActive, snykEnabled, type Violation } from "./policy.ts";
import { loadNpmrc, registryFor } from "./npmrc.ts";
import { buildJsonReport } from "./report.ts";
import { advisoryText, signalWarnings } from "./render.ts";
import { sanitizeTerminal } from "./sanitize.ts";
import { startSpinner } from "./spinner.ts";
import { healthColor } from "./colors.ts";
import { OSV_URL } from "./osv.ts";
import { VERSION } from "./version.ts";
import type { CliOptions, PackageReport } from "./types.ts";

export const TOOL_CMDS = new Set(["scan", "doctor", "cache-clear", "completions", "alias"]);

export async function runTool(
  name: string,
  args: string[],
  opts: CliOptions,
  cwd: string = process.cwd(),
): Promise<number> {
  switch (name) {
    case "scan":
      return scan(args, opts, cwd);
    case "doctor":
      return doctor(opts, cwd);
    case "cache-clear":
      return cacheClear();
    case "completions":
      return completions(args[0]);
    case "alias":
      console.log(aliasSnippet());
      return EXIT.OK;
    default:
      return EXIT.ERROR;
  }
}

// ---------------------------------------------------------------- scan

/** Workspace member dirs from package.json `workspaces` (array or `{ packages }`). */
export function workspaceDirs(cwd: string, root: Record<string, unknown>): string[] {
  const ws = root.workspaces;
  const patterns = Array.isArray(ws)
    ? ws
    : ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)
      ? (ws as { packages: unknown[] }).packages
      : [];
  const dirs: string[] = [];
  for (const pat of patterns) {
    if (typeof pat !== "string" || pat.startsWith("!")) continue;
    const clean = pat.replace(/^\.\//, "").replace(/\/+$/, "");
    // Supported shapes: "dir" and "dir/*" (the overwhelmingly common ones).
    // Deeper globs are skipped rather than guessed at.
    if (clean.endsWith("/*") && !clean.slice(0, -2).includes("*")) {
      const base = join(cwd, clean.slice(0, -2));
      try {
        for (const e of readdirSync(base, { withFileTypes: true })) {
          if (e.isDirectory() && existsSync(join(base, e.name, "package.json")))
            dirs.push(join(base, e.name));
        }
      } catch {
        /* missing base dir */
      }
    } else if (!clean.includes("*") && existsSync(join(cwd, clean, "package.json"))) {
      dirs.push(join(cwd, clean));
    }
  }
  return dirs;
}

/** Registry-installable deps declared in a package.json (+ workspace members), with the version on disk if present. */
export function readProjectDeps(
  cwd: string,
  prodOnly: boolean,
): { names: string[]; installed: Record<string, string>; skipped: string[]; workspaces: string[] } {
  const readJson = (dir: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  const root = readJson(cwd);
  const memberDirs = workspaceDirs(cwd, root);
  const members = memberDirs.map((d) => {
    try {
      return { dir: d, pkg: readJson(d) };
    } catch {
      return null;
    }
  });
  const manifests = [root, ...members.flatMap((m) => (m ? [m.pkg] : []))];
  // Members reference each other by plain ranges; they are local code, not registry deps.
  const localNames = new Set(
    members.flatMap((m) => (m && typeof m.pkg.name === "string" ? [m.pkg.name] : [])),
  );
  const tables = prodOnly
    ? ["dependencies", "optionalDependencies"]
    : ["dependencies", "devDependencies", "optionalDependencies"];
  const names = new Set<string>();
  const skipped: string[] = [];
  for (const manifest of manifests) {
    for (const t of tables) {
      const table = manifest[t];
      if (!table || typeof table !== "object") continue;
      for (const [dep, range] of Object.entries(table as Record<string, unknown>)) {
        if (localNames.has(dep)) continue;
        // Only plain registry ranges have intel; aliases/git/file/workspace do not.
        if (
          typeof range === "string" &&
          /^(file:|link:|workspace:|npm:|git|https?:|[\w.-]+\/[\w.-]+(#.*)?$)/.test(range)
        ) {
          if (!skipped.includes(dep)) skipped.push(dep);
          continue;
        }
        names.add(dep);
      }
    }
  }
  const installed: Record<string, string> = {};
  for (const n of names) {
    try {
      const v = readJson(join(cwd, "node_modules", n)).version;
      if (typeof v === "string") installed[n] = v;
    } catch {
      /* not installed: advisories fall back to the registry's latest */
    }
  }
  return {
    names: [...names].sort(),
    installed,
    skipped,
    workspaces: members.flatMap((m) =>
      m ? [typeof m.pkg.name === "string" ? m.pkg.name : m.dir] : [],
    ),
  };
}

async function scan(args: string[], opts: CliOptions, cwd: string): Promise<number> {
  if (!existsSync(join(cwd, "package.json"))) {
    console.error(paint(c.red, "  ✖ no package.json in the current directory."));
    return EXIT.ERROR;
  }
  let deps: ReturnType<typeof readProjectDeps>;
  try {
    deps = readProjectDeps(cwd, args.includes("--prod"));
  } catch (err) {
    console.error(
      paint(c.red, `  ✖ cannot read package.json: ${err instanceof Error ? err.message : err}`),
    );
    return EXIT.ERROR;
  }
  if (deps.names.length === 0) {
    console.log(paint(c.dim, "  ◌ no registry dependencies to scan."));
    return EXIT.OK;
  }

  const spinner = opts.json ? null : startSpinner(`scanning ${deps.names.length} dependencies`);
  let reports: PackageReport[];
  try {
    reports = await inspectPackages(deps.names, {
      cwd,
      registry: opts.registry,
      skipDeps: true,
      noSnyk: opts.noSnyk || !snykEnabled(cwd),
      concurrency: 8,
      versionFor: (n) => deps.installed[n],
    });
  } finally {
    spinner?.stop();
  }

  const policy = effectivePolicy(cwd, opts.minScore);
  const violations = evaluate(reports, policy);
  const lookedUp = reports.filter((r) => r.meta !== null);
  const allFailed = lookedUp.length === 0;

  if (opts.json) {
    console.log(JSON.stringify(buildJsonReport("scan", reports, policy, violations), null, 2));
  } else {
    printScan(reports, deps, violations, isActive(policy));
  }
  if (allFailed) return EXIT.UNAVAILABLE;
  return violations.length > 0 ? EXIT.BLOCKED : EXIT.OK;
}

/** Worst first: vulnerable, then low score, then unknown. */
function scanRank(r: PackageReport): number {
  const vulns = r.vulns?.count ?? 0;
  const score = r.health.score ?? 50;
  return -(vulns > 0 ? 1000 + vulns : 0) + score;
}

function printScan(
  reports: PackageReport[],
  deps: ReturnType<typeof readProjectDeps>,
  violations: Violation[],
  policyActive: boolean,
): void {
  const ok = reports.filter((r) => r.meta).sort((a, b) => scanRank(a) - scanRank(b));
  const failed = reports.filter((r) => !r.meta);
  console.log("");
  console.log(paint(c.pink, "  ◆ nps scan") + paint(c.cyan, `  ${reports.length} dependencies`));
  console.log(paint(c.blue, "─".repeat(52)));
  const width = Math.max(...ok.map((r) => r.meta!.name.length), 4);
  for (const r of ok) {
    const m = r.meta!;
    const ver = deps.installed[m.name] ?? m.version;
    const score =
      r.health.score === null
        ? paint(c.white, "  n/a")
        : paint(healthColor(r.health.score), `${String(r.health.score).padStart(3)}/100`);
    const adv = advisoryText(r) ?? "";
    console.log(
      `  ${paint(c.cyan, "•")} ${paint(c.white, sanitizeTerminal(m.name).padEnd(width))} ` +
        `${paint(c.white, `v${sanitizeTerminal(ver)}`.padEnd(10))} ${score}  ${adv}`,
    );
    for (const w of signalWarnings(r)) console.log(`      ${paint(c.orange, `⚠ ${w}`)}`);
  }
  for (const r of failed) {
    console.log(
      paint(c.red, `  ✖ ${sanitizeTerminal(r.query)}`) +
        paint(c.white, `  — ${sanitizeTerminal(r.metaError ?? "lookup failed")}`),
    );
  }
  console.log(paint(c.blue, "─".repeat(52)));
  if (deps.workspaces.length > 0) {
    console.log(paint(c.dim, `  ◈ workspaces included: ${deps.workspaces.join(", ")}`));
  }
  if (deps.skipped.length > 0) {
    console.log(paint(c.dim, `  ◌ skipped non-registry deps: ${deps.skipped.join(", ")}`));
  }
  const vulnerable = ok.filter((r) => (r.vulns?.count ?? 0) > 0).length;
  console.log(
    paint(
      vulnerable > 0 ? c.red : c.green,
      `  ${vulnerable} of ${ok.length} with known advisories`,
    ),
  );
  if (violations.length > 0) {
    console.log(paint(c.red, `  ✖ blocked by policy (${violations.length}):`));
    for (const v of violations) console.log(paint(c.red, `    - ${sanitizeTerminal(v.message)}`));
  } else if (policyActive) {
    console.log(paint(c.green, "  ✔ policy passed"));
  }
}

// -------------------------------------------------------------- doctor

interface Check {
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

async function probe(
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
): Promise<string | null> {
  try {
    const res = await fetchWithRetry(url, init, { timeoutMs: 5000, maxAttempts: 1 });
    try {
      await res.arrayBuffer?.();
    } catch {
      /* body not needed */
    }
    return res.ok ? null : `HTTP ${res.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : "unreachable";
  }
}

export async function runChecks(opts: CliOptions, cwd: string): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push({
    label: "nps",
    status: "ok",
    detail: `v${VERSION} on ${process.release?.name ?? "node"} ${process.version}`,
  });

  try {
    const { pm, via } = detectPm(opts.pmOverride);
    checks.push({ label: "package manager", status: "ok", detail: `${pm} (detected: ${via})` });
  } catch (err) {
    checks.push({
      label: "package manager",
      status: "fail",
      detail: err instanceof PmError ? err.message : String(err),
    });
  }

  const cfgPath = join(cwd, CONFIG_FILE);
  checks.push(
    existsSync(cfgPath)
      ? { label: "config", status: "ok", detail: cfgPath }
      : { label: "config", status: "ok", detail: `none (${CONFIG_FILE} is optional)` },
  );

  const stats = cacheStats();
  checks.push({
    label: "cache",
    status: stats.enabled ? "ok" : "warn",
    detail: stats.enabled
      ? `${stats.entries} entries, ${(stats.bytes / 1024).toFixed(1)} KiB at ${stats.file}`
      : "disabled (NPS_NO_CACHE / --no-cache)",
  });

  const registry = registryFor("nps-doctor", loadNpmrc(cwd), opts.registry);
  const [reg, snyk, osv] = await Promise.all([
    probe(`${registry}/-/ping`),
    probe("https://security.snyk.io/package/npm/left-pad"),
    probe(OSV_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: { name: "left-pad", ecosystem: "npm" }, version: "1.3.0" }),
    }),
  ]);
  checks.push({
    label: "registry",
    status: reg ? "fail" : "ok",
    detail: reg ? `${registry} — ${reg}` : registry,
  });
  checks.push({
    label: "snyk health",
    status: snyk ? "warn" : "ok",
    detail: snyk ?? "security.snyk.io reachable",
  });
  checks.push({
    label: "osv advisories",
    status: osv ? "warn" : "ok",
    detail: osv ?? "api.osv.dev reachable",
  });
  return checks;
}

async function doctor(opts: CliOptions, cwd: string): Promise<number> {
  const checks = await runChecks(opts, cwd);
  console.log("");
  console.log(paint(c.pink, "  ◆ nps doctor"));
  for (const k of checks) {
    const mark =
      k.status === "ok"
        ? paint(c.green, "✔")
        : k.status === "warn"
          ? paint(c.yellow, "⚠")
          : paint(c.red, "✖");
    console.log(`  ${mark} ${paint(c.cyan, k.label.padEnd(16))} ${sanitizeTerminal(k.detail)}`);
  }
  return checks.some((k) => k.status === "fail") ? EXIT.ERROR : EXIT.OK;
}

// --------------------------------------------------------- cache-clear

function cacheClear(): number {
  const removed = purgeIntelCache();
  console.log(paint(c.green, `  ✔ cleared nps intel cache (${removed} entries)`));
  return EXIT.OK;
}

// --------------------------------------------------------- completions

function completions(shell: string | undefined): number {
  if (!shell || !(SHELLS as readonly string[]).includes(shell)) {
    console.error(paint(c.red, `  ✖ usage: nps completions <${SHELLS.join("|")}>`));
    return EXIT.ERROR;
  }
  console.log(completionScript(shell as Shell).trimEnd());
  return EXIT.OK;
}
