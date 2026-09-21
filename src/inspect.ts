// Package inspection: registry metadata + health + transitive counts.
// Pure orchestration over the intel sources — reusable without the CLI
// (import inspectPackages for programmatic use).
import { fetchNpmMeta } from "./npm.ts";
import { fetchHealth } from "./snyk.ts";
import { countTransitive } from "./deps.ts";
import { splitSpec } from "./spec.ts";
import type { PackageReport } from "./types.ts";

export async function inspectOne(query: string): Promise<PackageReport> {
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

/** Inspect every query in parallel; order of results matches input. */
export function inspectPackages(queries: string[]): Promise<PackageReport[]> {
  return Promise.all(queries.map(inspectOne));
}
