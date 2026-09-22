// Package inspection: registry metadata + health + transitive counts.
// Pure orchestration over the intel sources — reusable without the CLI
// (import inspectPackages for programmatic use).
import { fetchNpmMeta, type FetchMetaOptions } from "./npm.ts";
import { fetchHealth } from "./snyk.ts";
import { countTransitive } from "./deps.ts";
import { persistIntelCacheSync } from "./cache.ts";
import { splitSpec, isRegistrySpec } from "./spec.ts";
import type { PackageReport } from "./types.ts";

function finish(query: string, t0: number, rest: Omit<PackageReport, "query" | "elapsedMs">): PackageReport {
  // Persist once per report so short-lived CLI processes don't lose the
  // last cache writes to the debounced async flush. Warm hits do zero
  // writes, so this is free on the fast path.
  try {
    persistIntelCacheSync();
  } catch {
    /* cache must never break intel */
  }
  return { query, elapsedMs: Date.now() - t0, ...rest };
}

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
    return finish(query, t0, {
      meta: null,
      metaError: metaRes.reason instanceof Error ? metaRes.reason.message : "fetch failed",
      health: health.status === "fulfilled" ? health.value : { score: null, breakdown: null },
      directCount: 0,
      transitiveCount: 0,
      totalCount: 0,
      transitiveNames: [],
      truncated: false,
    });
  }
  const meta = metaRes.value;
  const { count, names, truncated } = await countTransitive(meta.directDeps, opts);
  return finish(query, t0, {
    meta,
    metaError: null,
    health: health.status === "fulfilled" ? health.value : { score: null, breakdown: null },
    directCount: meta.directDeps.length,
    transitiveCount: count,
    totalCount: meta.directDeps.length + count,
    transitiveNames: names,
    truncated,
  });
}

/** Inspect every query in parallel; order of results matches input.
 *
 * Real parallelism, not sequential: every package's meta + health fetches
 * start in the same tick (no await between kick-offs), and each package's
 * transitive crawl starts the moment its own meta resolves — never waiting
 * for slower siblings. Overlapping transitive graphs share one in-flight
 * fetch per unique node via the dedup in npm.ts / deps.ts, and warm nodes
 * return from the persistent cache with zero network. `Promise.all`
 * preserves input order for rendering.
 */
export function inspectPackages(
  queries: string[],
  opts?: FetchMetaOptions,
): Promise<PackageReport[]> {
  // Kick off ALL packages immediately — `map` runs synchronously, so every
  // fetchNpmMeta/fetchHealth below is in flight before the first await.
  const pending = queries.map((q) => inspectOne(q, opts));
  return Promise.all(pending);
}
