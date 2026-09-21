import { fetchNpmMeta } from "./npm.ts";

const CONCURRENCY = 20;
const MAX_NODES = 1200;

// Counts unique transitive deps via BFS over /:pkg/latest.
// Version ranges are ignored (latest resolved) — a speed/accuracy trade-off:
// exact semver resolution would need the full packument per node.
// Shared cache keeps multi-package installs fast (express+lodash share deps).
const metaCache = new Map<string, string[]>();

async function directOf(name: string): Promise<string[]> {
  const hit = metaCache.get(name);
  if (hit) return hit;
  try {
    const meta = await fetchNpmMeta(name);
    metaCache.set(name, meta.directDeps);
    return meta.directDeps;
  } catch {
    metaCache.set(name, []);
    return [];
  }
}

export async function countTransitive(direct: string[]): Promise<{ count: number; names: string[] }> {
  const seen = new Set<string>(direct);
  const queue: string[] = [...direct];
  while (queue.length > 0) {
    if (seen.size >= MAX_NODES) break;
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
  return { count: transitive.length, names: transitive.sort() };
}
