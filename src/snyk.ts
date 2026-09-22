import type { Health } from "./types.ts";
import { fetchWithRetry } from "./fetch.ts";
import { getCache, healthKey, HEALTH_TTL_MS, setCache } from "./cache.ts";
import { encodePkg, isValidPkgName } from "./spec.ts";

/** Scraped HTML is only scanned for small markers: never buffer more. */
export const MAX_HTML_BYTES = 1_000_000;

// Scrapes https://security.snyk.io/package/npm/:pkg (no API key needed).
// Markers observed in the wild:
//   <span class="score-number">80/100</span>
//   <span class="criterion-label">security</span> ... <!--[-->No known security issues<!--]-->
//
// Warm path: parsed results are cached (memory + disk, 24h) so repeat
// installs skip the scrape entirely. Concurrent callers share one
// in-flight fetch. Only completed parses are cached — network failures
// and unparsable pages revalidate every time (fail-open stays).
const inflight = new Map<string, Promise<Health>>();

export function clearHealthInflight(): void {
  inflight.clear();
}

export async function fetchHealth(name: string): Promise<Health> {
  const empty: Health = { score: null, breakdown: null };
  if (!isValidPkgName(name)) return empty;
  const key = healthKey(name);
  const cached = getCache<Health>(key);
  if (cached) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async (): Promise<Health> => {
    let html: string;
    try {
      const res = await fetchWithRetry(
        `https://security.snyk.io/package/npm/${encodePkg(name)}`,
        {
          headers: {
            "User-Agent": "nps/0.1.0",
            Accept: "text/html",
          },
        },
        { timeoutMs: 10000 },
      );
      if (!res.ok) return empty;
      // Unbounded pages (proxy errors, markup changes) would blow up memory
      // and the regexes below: bail out early on a large declared size…
      const declared = Number(res.headers?.get?.("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) return empty;
      html = await res.text();
      // …and enforce the same cap on the actual body (missing/lying header).
      if (html.length > MAX_HTML_BYTES) return empty;
    } catch {
      return empty;
    }

    const scoreMatch = html.match(/score-number[^>]*>\s*(\d{1,3})\s*\/\s*100/s);
    const score = scoreMatch?.[1] ? Math.min(100, Math.max(0, parseInt(scoreMatch[1], 10))) : null;

    const breakdown = {
      security: pick(html, "security"),
      popularity: pick(html, "popularity"),
      maintenance: pick(html, "maintenance"),
      community: pick(html, "community"),
    };
    const hasAny = Object.values(breakdown).some((v) => v !== "n/a");
    // A 200 with zero markers means the page shape changed (or a bot wall),
    // not a healthy package — flag it so callers can say so out loud instead
    // of silently rendering "unreachable".
    if (score === null && !hasAny) return { score, breakdown: null, unparsed: true };
    const out: Health = { score, breakdown: hasAny ? breakdown : null };
    setCache(key, out, HEALTH_TTL_MS);
    return out;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    if (inflight.get(key) === p) inflight.delete(key);
  }
}

function pick(html: string, label: string): string {
  const labelRe = new RegExp(`criterion-label[^>]*>\\s*${label}\\s*<\\/span>`, "i");
  const match = html.match(labelRe);
  if (!match || match.index === undefined) return "n/a";
  const afterLabel = html.slice(match.index + match[0].length, match.index + match[0].length + 1000);
  const spanMatch = afterLabel.match(/<span[^>]*>([\s\S]*?)<\/span>/i);
  if (!spanMatch || !spanMatch[1]) return "n/a";
  const content = spanMatch[1]
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
  return content || "n/a";
}
