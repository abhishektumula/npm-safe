// Package inspection: registry metadata + health + transitive counts.
// Pure orchestration over the intel sources — reusable without the CLI
// (import inspectPackages for programmatic use).
import { fetchNpmMeta, type FetchMetaOptions } from "./npm.ts";
import { fetchHealth } from "./snyk.ts";
import { countTransitive } from "./deps.ts";
import { splitSpec, isRegistrySpec } from "./spec.ts";
import type { PackageReport } from "./types.ts";

export async function inspectOne(query: string, opts?: FetchMetaOptions): Promise<PackageReport> {
  const t0 = Date.now();

  // Non-registry specs (GitHub shorthand, file:, link:, tarball URLs) skip intel
  if (!isRegistrySpec(query)) {
    return {
      query,
      meta: null,
      metaError: "non-registry spec (intel skipped)",
      health: { score: null, breakdown: null },
      directCount: 0,
      transitiveCount: 0,
      totalCount: 0,
      transitiveNames: [],
      truncated: false,
      elapsedMs: Date.now() - t0,
      isNonRegistry: true,
    };
  }

  const { name } = splitSpec(query);
  const lookup = name || query;
  const [metaRes, health] = await Promise.allSettled([
    fetchNpmMeta(lookup, opts),
    fetchHealth(lookup),
  ]);
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
      truncated: false,
      elapsedMs: Date.now() - t0,
    };
  }
  const meta = metaRes.value;
  const { count, names, truncated } = await countTransitive(meta.directDeps, opts);
  return {
    query,
    meta,
    metaError: null,
    health: health.status === "fulfilled" ? health.value : { score: null, breakdown: null },
    directCount: meta.directDeps.length,
    transitiveCount: count,
    totalCount: meta.directDeps.length + count,
    transitiveNames: names,
    truncated,
    elapsedMs: Date.now() - t0,
  };
}

/** Inspect every query in parallel; order of results matches input. */
export function inspectPackages(
  queries: string[],
  opts?: FetchMetaOptions,
): Promise<PackageReport[]> {
  return Promise.all(queries.map((q) => inspectOne(q, opts)));
}
