import { fetchNpmMeta, type FetchMetaOptions } from "./npm.ts";

const CONCURRENCY = 20;
const MAX_NODES = 1200;

// Counts unique transitive deps via BFS over /:pkg/latest.
// Version ranges are ignored (latest resolved) — a speed/accuracy trade-off:
// exact semver resolution would need the full packument per node.
// Shared cache keeps multi-package installs fast (express+lodash share deps).
// Keyed by registry + name so a `--registry` run never reuses public data.
const metaCache = new Map<string, string[]>();

async function directOf(name: string, opts?: FetchMetaOptions): Promise<string[]> {
  const key = `${opts?.registry ?? ""}\n${name}`;
  const hit = metaCache.get(key);
  if (hit) return hit;
  try {
    const meta = await fetchNpmMeta(name, opts);
    metaCache.set(key, meta.directDeps);
    return meta.directDeps;
  } catch {
    metaCache.set(key, []);
    return [];
  }
}

export async function countTransitive(
  direct: string[],
  opts?: FetchMetaOptions,
): Promise<{ count: number; names: string[] }> {
  const seen = new Set<string>(direct);
  const queue: string[] = [...direct];
  while (queue.length > 0) {
    if (seen.size >= MAX_NODES) break;
    const batch = queue.splice(0, CONCURRENCY);
    const results = await Promise.all(batch.map((name) => directOf(name, opts)));
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
  return { count: transitive.length, names: transitive.sort() };
}
