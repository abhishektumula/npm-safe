// Fallback health score from free, structured sources — used when the Snyk
// scrape is unreachable, unparsable, or switched off, so a layout change on
// one website no longer turns every card (and every --min-score gate) into
// "n/a". Pure: inputs are what inspectOne already fetched.
//
// Four components, 0–100 each, mirroring Snyk's breakdown:
//   security    OSV advisories for this exact version (+ verified provenance)
//   popularity  weekly npm downloads (log scale: 10M/week = 100)
//   maintenance Scorecard "Maintained" check, else publish recency; deprecated = 0
//   community   OpenSSF Scorecard overall, else GitHub stars (log scale)
// Unknown components are left out and the weights re-normalize; fewer than
// two known components is not enough evidence, so the result stays null.
import type { Health, HealthBreakdown, Project, Vulns } from "./types.ts";

export interface EstimateInput {
  vulns?: Vulns | null;
  downloads?: number | null;
  project?: Project | null;
  deprecated?: string | null;
  now?: number;
}

const WEIGHTS = { security: 0.3, popularity: 0.25, maintenance: 0.25, community: 0.2 };
type Part = keyof typeof WEIGHTS;

const DAY = 24 * 3600 * 1000;

function clamp(n: number): number {
  return Math.round(Math.min(100, Math.max(0, n)));
}

/** log10 scale: `full` maps to 100, 1 maps to 0. */
function logScale(n: number, full: number): number {
  return clamp((Math.log10(Math.max(1, n)) / Math.log10(full)) * 100);
}

function security(v: Vulns | null | undefined, p: Project | null | undefined): number | null {
  if (!v) return null;
  if (v.count === 0) return p?.provenance ? 100 : 95;
  const bySeverity = { critical: 0, high: 20, moderate: 50, low: 75 } as const;
  // An advisory without a stated severity is treated as serious, not safe.
  return v.worst ? bySeverity[v.worst] : 30;
}

function maintenance(input: EstimateInput, now: number): number | null {
  if (input.deprecated) return 0;
  const m = input.project?.maintained;
  if (typeof m === "number") return clamp(m * 10);
  const t = input.project?.publishedAt ? Date.parse(input.project.publishedAt) : NaN;
  if (!Number.isFinite(t)) return null;
  const days = (now - t) / DAY;
  if (days < 180) return 90;
  if (days < 365) return 75;
  if (days < 2 * 365) return 55;
  if (days < 4 * 365) return 35;
  return 20;
}

function community(p: Project | null | undefined): number | null {
  if (typeof p?.scorecard === "number") return clamp(p.scorecard * 10);
  if (typeof p?.stars === "number") return logScale(p.stars, 10_000);
  return null;
}

function label(part: Part, score: number | null, input: EstimateInput): string {
  if (score === null) return "n/a";
  if (part === "security") {
    if (input.vulns?.count === 0) return "No known security issues";
    return `${input.vulns?.count} known advisor${input.vulns?.count === 1 ? "y" : "ies"}`;
  }
  if (part === "popularity") {
    if (score >= 85) return "Key ecosystem project";
    if (score >= 55) return "Popular";
    if (score >= 30) return "Limited";
    return "Small";
  }
  if (part === "maintenance" && input.deprecated) return "Inactive (deprecated)";
  if (score >= 70) return part === "maintenance" ? "Healthy" : "Active";
  if (score >= 40) return "Sustainable";
  return part === "maintenance" ? "Inactive" : "Limited";
}

/** Health estimate (source "estimate"), or null when under two components are known. */
export function estimateHealth(input: EstimateInput): Health | null {
  const now = input.now ?? Date.now();
  const parts: Record<Part, number | null> = {
    security: security(input.vulns, input.project),
    popularity: typeof input.downloads === "number" ? logScale(input.downloads, 10_000_000) : null,
    maintenance: maintenance(input, now),
    community: community(input.project),
  };
  let sum = 0;
  let weight = 0;
  for (const k of Object.keys(WEIGHTS) as Part[]) {
    const v = parts[k];
    if (v === null) continue;
    sum += v * WEIGHTS[k];
    weight += WEIGHTS[k];
  }
  const known = Object.values(parts).filter((v) => v !== null).length;
  if (known < 2 || weight === 0) return null;
  let score = clamp(sum / weight);
  // A critical/high advisory or deprecation caps the total: averages must
  // not let a million downloads paper over a known-exploitable version.
  if (input.deprecated) score = Math.min(score, 40);
  if (input.vulns?.worst === "critical") score = Math.min(score, 25);
  else if (input.vulns?.worst === "high") score = Math.min(score, 45);
  const breakdown: HealthBreakdown = {
    security: label("security", parts.security, input),
    popularity: label("popularity", parts.popularity, input),
    maintenance: label("maintenance", parts.maintenance, input),
    community: label("community", parts.community, input),
  };
  return { score, breakdown, source: "estimate" };
}
