import { fetchNpmMeta } from "./npm.ts";

const CONCURRENCY = 20;
const MAX_NODES = 1200;
/** Worst-case wall clock for one count: stale lookups degrade, never hang. */
export const MAX_CRAWL_MS = 15000;

// Counts unique transitive deps via BFS over /:pkg/latest.
// Version ranges are ignored (latest resolved) — a speed/accuracy trade-off:
// exact semver resolution would need the full packument per node.
// Shared cache keeps multi-package installs fast (express+lodash share deps).
const MAX_CACHE_SIZE = 2000;
const metaCache = new Map<string, string[]>();

async function directOf(name: string): Promise<string[]> {
  const hit = metaCache.get(name);
  if (hit) return hit;
  try {
    const meta = await fetchNpmMeta(name);
    if (metaCache.size >= MAX_CACHE_SIZE) metaCache.clear();
    metaCache.set(name, meta.directDeps);
    return meta.directDeps;
  } catch {
    if (metaCache.size >= MAX_CACHE_SIZE) metaCache.clear();
    metaCache.set(name, []);
    return [];
  }
}

export interface CrawlOptions {
  /** override the wall-clock budget (tests; production uses MAX_CRAWL_MS) */
  maxMs?: number;
}

export async function countTransitive(
  direct: string[],
  opts: CrawlOptions = {},
): Promise<{ count: number; names: string[]; truncated: boolean }> {
  const budget = opts.maxMs ?? MAX_CRAWL_MS;
  const t0 = Date.now();
  const seen = new Set<string>(direct);
  const queue: string[] = [...direct];
  let truncated = false;
  while (queue.length > 0) {
    if (seen.size >= MAX_NODES || Date.now() - t0 >= budget) {
      truncated = true;
      break;
    }
    const batch = queue.splice(0, CONCURRENCY);
    const results = await Promise.all(batch.map(directOf));
    for (const deps of results) {
      for (const d of deps) {
        if (!seen.has(d)) {
          seen.add(d);
          queue.push(d);
        }
      }
    }
  }
  const transitive = [...seen].filter((n) => !direct.includes(n));
  return { count: transitive.length, names: transitive.sort(), truncated };
}
