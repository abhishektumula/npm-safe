// Package inspection: registry metadata + health + transitive counts.
// Pure orchestration over the intel sources — reusable without the CLI
// (import inspectPackages for programmatic use).
import { fetchNpmMeta, type FetchMetaOptions } from "./npm.ts";
import { fetchHealth } from "./snyk.ts";
import { countTransitive } from "./deps.ts";
import { fetchWeeklyDownloads } from "./downloads.ts";
import { fetchVulns } from "./osv.ts";
import { signalsOf } from "./signals.ts";
import { DEFAULT_REGISTRY, loadNpmrc, registryFor } from "./npmrc.ts";
import { vlog } from "./log.ts";
import { persistIntelCacheSync } from "./cache.ts";
import { splitSpec, isRegistrySpec } from "./spec.ts";
import type { Health, PackageReport } from "./types.ts";

export interface InspectOptions extends FetchMetaOptions {
  /** skip the transitive crawl (project scans: counts aren't the point) */
  skipDeps?: boolean;
  /** version to query advisories for, instead of the registry's latest */
  versionFor?: (name: string) => string | undefined;
  /** skip the Snyk scrape (ToS-conservative / offline-friendly) */
  noSnyk?: boolean;
  /** max packages inspected at once (default: all) */
  concurrency?: number;
}

/** True when .npmrc routes this package somewhere other than registry.npmjs.org. */
function hasCustomRegistry(name: string, cwd?: string): boolean {
  return registryFor(name, loadNpmrc(cwd ?? process.cwd()), null) !== DEFAULT_REGISTRY;
}

function finish(
  query: string,
  t0: number,
  rest: Omit<PackageReport, "query" | "elapsedMs">,
): PackageReport {
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

export async function inspectOne(query: string, opts?: InspectOptions): Promise<PackageReport> {
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
    opts?.noSnyk
      ? Promise.resolve<Health>({ score: null, breakdown: null, skipped: true })
      : fetchHealth(lookup),
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
  const healthVal = health.status === "fulfilled" ? health.value : { score: null, breakdown: null };
  // Advisories need the exact version; start them alongside the crawl.
  const vulnVersion = opts?.versionFor?.(lookup) ?? meta.version;
  // The download endpoint only exists on the public registry.
  const publicRegistry = !opts?.registry && !hasCustomRegistry(lookup, opts?.cwd);
  const [crawl, vulns, downloads] = await Promise.all([
    opts?.skipDeps
      ? Promise.resolve({ count: 0, names: [] as string[], truncated: false })
      : countTransitive(meta.directDeps, opts),
    fetchVulns(meta.name, vulnVersion),
    publicRegistry ? fetchWeeklyDownloads(meta.name) : Promise.resolve(null),
  ]);
  const { count, names, truncated } = crawl;
  vlog(`${query}: inspected in ${Date.now() - t0}ms`);
  return finish(query, t0, {
    meta,
    metaError: null,
    health: healthVal,
    directCount: meta.directDeps.length,
    transitiveCount: count,
    totalCount: meta.directDeps.length + count,
    transitiveNames: names,
    truncated,
    vulns,
    downloads,
    signals: signalsOf(meta, downloads),
    stale: Boolean(meta.stale || healthVal.stale || vulns?.stale),
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
export async function inspectPackages(
  queries: string[],
  opts?: InspectOptions,
): Promise<PackageReport[]> {
  const limit = opts?.concurrency;
  if (!limit || limit >= queries.length) {
    // Kick off ALL packages immediately — `map` runs synchronously, so every
    // fetchNpmMeta/fetchHealth below is in flight before the first await.
    return Promise.all(queries.map((q) => inspectOne(q, opts)));
  }
  // Bounded pool for big lists (project scans): workers pull the next index.
  const results = new Array<PackageReport>(queries.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < queries.length) {
      const i = next++;
      results[i] = await inspectOne(queries[i]!, opts);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}
