import { fetchNpmMeta, type FetchMetaOptions } from "./npm.ts";

const CONCURRENCY = 20;
const MAX_NODES = 1200;
/** Worst-case wall clock for one count: stale lookups degrade, never hang. */
export const MAX_CRAWL_MS = 15000;
const MAX_CACHE_SIZE = 2000;

// Counts unique transitive deps via BFS over /:pkg/latest.
// Version ranges are ignored (latest resolved) — a speed/accuracy trade-off:
// exact semver resolution would need the full packument per node.
// Shared cache keeps multi-package installs fast (express+lodash share deps).
// Keyed by registry + name so a `--registry` run never reuses public data.
//
// Parallelism: the crawl keeps CONCURRENCY fetches in flight at all times
// with continuous replenishment (no batch barrier — a slow straggler never
// idles the other 19 slots). Concurrent callers for the same package share
// one in-flight fetch, so `inspectPackages([a, b])` with overlapping graphs
// issues exactly one network call per unique node. Warm nodes return from
// the persistent intel cache with zero network.
const metaCache = new Map<string, string[]>();
const inflight = new Map<string, Promise<string[]>>();

export function clearDepsCache(): void {
  metaCache.clear();
  inflight.clear();
}

async function directOf(name: string, opts?: FetchMetaOptions): Promise<string[]> {
  const key = `${opts?.registry ?? ""}\n${name}`;
  const hit = metaCache.get(key);
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async (): Promise<string[]> => {
    try {
      const meta = await fetchNpmMeta(name, opts);
      if (metaCache.size >= MAX_CACHE_SIZE) metaCache.clear();
      metaCache.set(key, meta.directDeps);
      return meta.directDeps;
    } catch {
      if (metaCache.size >= MAX_CACHE_SIZE) metaCache.clear();
      metaCache.set(key, []);
      return [];
    }
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    if (inflight.get(key) === p) inflight.delete(key);
  }
}

export interface CrawlOptions {
  /** override the wall-clock budget (tests; production uses MAX_CRAWL_MS) */
  maxMs?: number;
}

export async function countTransitive(
  direct: string[],
  opts?: FetchMetaOptions & CrawlOptions,
): Promise<{ count: number; names: string[]; truncated: boolean }> {
  const budget = opts?.maxMs ?? MAX_CRAWL_MS;
  const t0 = Date.now();
  const seen = new Set<string>(direct);
  const queue: string[] = [...direct];
  let truncated = false;
  // Worker-pool crawl: keep CONCURRENCY fetches in flight at all times,
  // replenishing each slot the moment it resolves. The old batch barrier
  // (`await Promise.all(batch)`) idled 19 slots behind one straggler; here
  // a slow node never blocks the rest. Termination is via an in-flight
  // counter: workers exit only when the queue is empty AND nothing is still
  // resolving (which might yet enqueue more).
  if (queue.length === 0) return { count: 0, names: [], truncated: false };
  let active = 0;
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const workerCount = Math.min(CONCURRENCY, queue.length);
  // Shared queue array with an index cursor is cheaper than shift() per node.
  // `seen` guards enqueue so each unique dep is fetched at most once per
  // process (plus the cross-call inflight dedup in directOf).
  for (let w = 0; w < workerCount; w++) {
    workers.push(
      (async () => {
        while (true) {
          if (seen.size >= MAX_NODES || Date.now() - t0 >= budget) {
            truncated = true;
            return;
          }
          let name: string | undefined;
          // Critical section (single-threaded, so atomic): claim next item.
          if (cursor < queue.length) {
            name = queue[cursor++];
          } else {
            // Queue drained for now — exit only if no worker is still
            // resolving (otherwise it may enqueue more). Brief yield lets
            // in-flight fetches land before we decide.
            if (active === 0) return;
            await new Promise((r) => setTimeout(r, 0));
            continue;
          }
          active++;
          let deps: string[];
          try {
            deps = await directOf(name!, opts);
          } finally {
            active--;
          }
          if (seen.size >= MAX_NODES || Date.now() - t0 >= budget) {
            truncated = true;
            return;
          }
          for (const d of deps) {
            if (!seen.has(d)) {
              seen.add(d);
              queue.push(d);
            }
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  // If we exited via budget/nodes, remaining queue items are uncounted.
  if (seen.size >= MAX_NODES || Date.now() - t0 >= budget) truncated = true;
  const transitive = [...seen].filter((n) => !direct.includes(n));
  return { count: transitive.length, names: transitive.sort(), truncated };
}
