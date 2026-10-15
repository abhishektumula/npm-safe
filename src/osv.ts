// Second health source: OSV.dev advisories for an exact name@version.
// Structured JSON API (no scraping), so it keeps working when Snyk's page
// layout changes. Fail-open like every intel source: null = unreachable.
//   POST https://api.osv.dev/v1/query  {package:{name,ecosystem:"npm"},version}
import type { Vulns } from "./types.ts";
import { fetchWithRetry } from "./fetch.ts";
import { getCache, getCacheStale, osvKey, OSV_TTL_MS, setCache } from "./cache.ts";
import { isValidPkgName } from "./spec.ts";
import { vlog } from "./log.ts";
import { VERSION } from "./version.ts";

export const OSV_URL = "https://api.osv.dev/v1/query";
const MAX_IDS = 10;
const MAX_BYTES = 2_000_000;

const RANK = { low: 1, moderate: 2, high: 3, critical: 4 } as const;
type Sev = keyof typeof RANK;

/** Map GitHub-style database_specific.severity (LOW/MODERATE/HIGH/CRITICAL). */
function severityOf(vuln: Record<string, any>): Sev | null {
  const raw = vuln?.database_specific?.severity;
  if (typeof raw !== "string") return null;
  const v = raw.toLowerCase();
  if (v === "medium") return "moderate";
  return v in RANK ? (v as Sev) : null;
}

/** Pure: collapse an OSV response body into counts. */
export function summarizeOsv(body: unknown): Vulns {
  const list = (body as { vulns?: unknown })?.vulns;
  const vulns = Array.isArray(list) ? (list as Record<string, any>[]) : [];
  let worst: Sev | null = null;
  const ids: string[] = [];
  for (const v of vulns) {
    if (typeof v?.id === "string" && ids.length < MAX_IDS) ids.push(v.id);
    const sev = severityOf(v);
    if (sev && (worst === null || RANK[sev] > RANK[worst])) worst = sev;
  }
  return { count: vulns.length, ids, worst };
}

const inflight = new Map<string, Promise<Vulns | null>>();

export function clearOsvInflight(): void {
  inflight.clear();
}

export async function fetchVulns(name: string, version: string): Promise<Vulns | null> {
  if (!isValidPkgName(name) || !version || version === "n/a") return null;
  const key = osvKey(name, version);
  const cached = getCache<Vulns>(key);
  if (cached) {
    vlog(`cache hit: ${name}@${version} (osv)`);
    return cached;
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async (): Promise<Vulns | null> => {
    vlog(`cache miss: ${name}@${version} (osv) -> api.osv.dev`);
    try {
      const res = await postJson({ package: { name, ecosystem: "npm" }, version });
      if (!res.ok) throw new Error(`osv responded ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error("osv response too large");
      const out = summarizeOsv(JSON.parse(text));
      setCache(key, out, OSV_TTL_MS);
      return out;
    } catch (err) {
      const old = getCacheStale<Vulns>(key);
      vlog(
        `${name}@${version}: osv failed (${err instanceof Error ? err.message : err})${old ? " — using stale cache" : ""}`,
      );
      return old ? { ...old, stale: true } : null;
    }
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    if (inflight.get(key) === p) inflight.delete(key);
  }
}

function postJson(body: unknown): Promise<Response> {
  return fetchWithRetry(
    OSV_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": `nps/${VERSION}` },
      body: JSON.stringify(body),
    },
    { timeoutMs: 8000 },
  );
}
