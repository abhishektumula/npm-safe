// Weekly download count from api.npmjs.org — a popularity/abandonment hint.
// Public registry only: private registries have no such endpoint, so callers
// skip it when a custom registry is in play. Fail-open: null = unknown.
import { fetchWithRetry } from "./fetch.ts";
import { getCache, setCache, CACHE_VERSION, META_TTL_MS } from "./cache.ts";
import { encodePkg, isValidPkgName } from "./spec.ts";
import { vlog } from "./log.ts";

const inflight = new Map<string, Promise<number | null>>();

export function clearDownloadsInflight(): void {
  inflight.clear();
}

/** Packages under this many weekly downloads get a "rarely used" warning. */
export const LOW_DOWNLOADS = 100;

/** Compact count for display: 1234 -> 1.2K, 3_400_000 -> 3.4M. */
export function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

export async function fetchWeeklyDownloads(name: string): Promise<number | null> {
  if (!isValidPkgName(name)) return null;
  const key = `dl:${CACHE_VERSION}:${name.toLowerCase()}`;
  const cached = getCache<number>(key);
  if (typeof cached === "number") {
    vlog(`cache hit: ${name} (downloads)`);
    return cached;
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async (): Promise<number | null> => {
    vlog(`cache miss: ${name} (downloads) -> api.npmjs.org`);
    try {
      const res = await fetchWithRetry(
        `https://api.npmjs.org/downloads/point/last-week/${encodePkg(name)}`,
        { headers: { Accept: "application/json" } },
        { timeoutMs: 6000 },
      );
      if (!res.ok) return null;
      const n = ((await res.json()) as { downloads?: unknown }).downloads;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return null;
      setCache(key, n, META_TTL_MS);
      return n;
    } catch {
      return null;
    }
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    if (inflight.get(key) === p) inflight.delete(key);
  }
}
