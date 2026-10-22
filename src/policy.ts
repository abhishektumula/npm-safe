// Install policy: turns intel into a block/allow decision.
//
// Sources, flag wins over file:
//   --min-score N                     (CLI)
//   nps.config.json "policy": {
//     "minScore": 60,                 block when snyk health < 60 or unknown
//     "blockDeprecated": true,        block deprecated packages
//     "blockVulnerabilities": "high", block when an advisory >= severity exists
//     "allowedLicenses": ["MIT","ISC"], block anything else (unknown license too)
//     "minWeeklyDownloads": 1000,     block rarely-used packages (unknown passes)
//     "minReleaseAgeHours": 72        block versions younger than this (unknown passes)
//   }
//   nps.config.json "sources": { "snyk": false }   skip the Snyk scrape
// Fail-open on a malformed file (same rule as pmconfig): a config typo must
// not brick installs. Violations are reported per package; `-y` never skips
// them — the only override is to loosen the policy.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE } from "./pmconfig.ts";
import { hoursSince } from "./signals.ts";
import type { PackageReport } from "./types.ts";

export type Severity = "low" | "moderate" | "high" | "critical";
const RANK: Record<Severity, number> = { low: 1, moderate: 2, high: 3, critical: 4 };

export interface Policy {
  minScore: number | null;
  blockDeprecated: boolean;
  blockVulnerabilities: Severity | null;
  allowedLicenses: string[] | null;
  minWeeklyDownloads: number | null;
  minReleaseAgeHours: number | null;
}

export interface Violation {
  /** package the rule fired on (as the user typed it) */
  query: string;
  rule:
    | "min-score"
    | "health-unknown"
    | "deprecated"
    | "vulnerable"
    | "license"
    | "downloads"
    | "release-age";
  message: string;
}

export function emptyPolicy(): Policy {
  return {
    minScore: null,
    blockDeprecated: false,
    blockVulnerabilities: null,
    allowedLicenses: null,
    minWeeklyDownloads: null,
    minReleaseAgeHours: null,
  };
}

/** Pure parse; never throws. Invalid fields are ignored individually. */
export function parsePolicy(raw: unknown): Policy {
  const out = emptyPolicy();
  const p = raw && typeof raw === "object" ? (raw as { policy?: unknown }).policy : null;
  if (!p || typeof p !== "object" || Array.isArray(p)) return out;
  const o = p as Record<string, unknown>;
  if (typeof o.minScore === "number" && o.minScore >= 0 && o.minScore <= 100)
    out.minScore = o.minScore;
  if (typeof o.minWeeklyDownloads === "number" && o.minWeeklyDownloads >= 0) {
    out.minWeeklyDownloads = o.minWeeklyDownloads;
  }
  if (typeof o.minReleaseAgeHours === "number" && o.minReleaseAgeHours >= 0) {
    out.minReleaseAgeHours = o.minReleaseAgeHours;
  }
  if (o.blockDeprecated === true) out.blockDeprecated = true;
  if (typeof o.blockVulnerabilities === "string" && o.blockVulnerabilities in RANK) {
    out.blockVulnerabilities = o.blockVulnerabilities as Severity;
  }
  if (Array.isArray(o.allowedLicenses)) {
    const list = o.allowedLicenses.filter(
      (l): l is string => typeof l === "string" && l.trim() !== "",
    );
    if (list.length > 0) out.allowedLicenses = list.map((l) => l.trim().toLowerCase());
  }
  return out;
}

const cache = new Map<string, Policy>();

export function clearPolicyCache(): void {
  cache.clear();
  sourcesCache.clear();
}

export function loadPolicy(cwd: string): Policy {
  const hit = cache.get(cwd);
  if (hit) return hit;
  let policy = emptyPolicy();
  try {
    policy = parsePolicy(JSON.parse(readFileSync(join(cwd, CONFIG_FILE), "utf8")));
  } catch {
    /* fail-open */
  }
  cache.set(cwd, policy);
  return policy;
}

/** Layer the CLI flag over the file policy. */
export function effectivePolicy(cwd: string, minScoreFlag: number | null): Policy {
  const base = loadPolicy(cwd);
  return minScoreFlag === null ? base : { ...base, minScore: minScoreFlag };
}

export function isActive(p: Policy): boolean {
  return (
    p.minScore !== null ||
    p.blockDeprecated ||
    p.blockVulnerabilities !== null ||
    p.allowedLicenses !== null ||
    p.minWeeklyDownloads !== null ||
    p.minReleaseAgeHours !== null
  );
}

/** Pure. Non-registry specs and failed lookups carry no intel, so they are skipped here. */
export function evaluate(reports: PackageReport[], policy: Policy, now = Date.now()): Violation[] {
  const out: Violation[] = [];
  for (const r of reports) {
    if (r.isNonRegistry || !r.meta) continue;
    const name = `${r.meta.name}@${r.meta.version}`;
    if (policy.minScore !== null) {
      if (r.health.score === null) {
        out.push({
          query: r.query,
          rule: "health-unknown",
          message: `${name}: health unknown (min-score ${policy.minScore} requires a score)`,
        });
      } else if (r.health.score < policy.minScore) {
        out.push({
          query: r.query,
          rule: "min-score",
          message: `${name}: health ${r.health.score}/100${r.health.source === "estimate" ? " (nps estimate)" : ""} is below min-score ${policy.minScore}`,
        });
      }
    }
    if (policy.blockDeprecated && r.meta.deprecated) {
      out.push({
        query: r.query,
        rule: "deprecated",
        message: `${name}: deprecated by its maintainers`,
      });
    }
    if (policy.blockVulnerabilities && r.vulns && r.vulns.count > 0) {
      const floor = RANK[policy.blockVulnerabilities];
      // Advisories without a stated severity count as meeting any floor: unknown is not safe.
      const meets = r.vulns.worst === null || RANK[r.vulns.worst] >= floor;
      if (meets) {
        out.push({
          query: r.query,
          rule: "vulnerable",
          message: `${name}: ${r.vulns.count} known advisor${r.vulns.count === 1 ? "y" : "ies"}${r.vulns.worst ? ` (worst: ${r.vulns.worst})` : ""}`,
        });
      }
    }
    if (
      policy.minWeeklyDownloads !== null &&
      typeof r.downloads === "number" &&
      r.downloads < policy.minWeeklyDownloads
    ) {
      out.push({
        query: r.query,
        rule: "downloads",
        message: `${name}: ${r.downloads} weekly downloads is below minWeeklyDownloads ${policy.minWeeklyDownloads}`,
      });
    }
    const age = hoursSince(r.publishedAt, now);
    if (policy.minReleaseAgeHours !== null && age !== null && age < policy.minReleaseAgeHours) {
      out.push({
        query: r.query,
        rule: "release-age",
        message: `${name}: published ${Math.floor(age)}h ago, under minReleaseAgeHours ${policy.minReleaseAgeHours}`,
      });
    }
    if (policy.allowedLicenses) {
      const lic = r.meta.license.trim().toLowerCase();
      if (!policy.allowedLicenses.includes(lic)) {
        out.push({
          query: r.query,
          rule: "license",
          message: `${name}: license "${r.meta.license}" is not in allowedLicenses`,
        });
      }
    }
  }
  return out;
}

/** `--min-score` argument: integer 0–100, else null. */
export function parseMinScore(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 0 && n <= 100 ? n : null;
}

const sourcesCache = new Map<string, boolean>();

/** `nps.config.json` `sources.snyk` (default true). Fail-open like the rest. */
export function snykEnabled(cwd: string): boolean {
  const hit = sourcesCache.get(cwd);
  if (hit !== undefined) return hit;
  let on = true;
  try {
    const raw = JSON.parse(readFileSync(join(cwd, CONFIG_FILE), "utf8")) as {
      sources?: { snyk?: unknown };
    };
    if (raw?.sources?.snyk === false) on = false;
  } catch {
    /* fail-open */
  }
  sourcesCache.set(cwd, on);
  return on;
}
