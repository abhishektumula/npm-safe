import type { Health } from "./types.ts";

// Scrapes https://security.snyk.io/package/npm/:pkg (no API key needed).
// Markers observed in the wild:
//   <span class="score-number">80/100</span>
//   <span class="criterion-label">security</span> ... <!--[-->No known security issues<!--]-->
export async function fetchHealth(name: string): Promise<Health> {
  const empty: Health = { score: null, breakdown: null };
  let html: string;
  try {
    const res = await fetch(`https://security.snyk.io/package/npm/${encodeURIComponent(name)}`, {
      headers: {
        "User-Agent": "npm-safe/0.1.0",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return empty;
    html = await res.text();
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
  return { score, breakdown: hasAny ? breakdown : null };
}

function pick(html: string, label: string): string {
  // <span ...criterion-label...>security</span> ... <!--[-->VALUE<!--]-->
  const re = new RegExp(
    `criterion-label[^>]*>\\s*${label}\\s*</span>\\s*<span[^>]*>(?:<!--[\\s\\S]*?-->\\s*)*(?:<svg[\\s\\S]*?</svg>\\s*)?(?:<!--[\\s\\S]*?-->\\s*)*([^<\\]]+)`,
    "i",
  );
  const m = html.match(re);
  const val = m?.[1]?.trim().replace(/<!--|-->/g, "").trim();
  return val || "n/a";
}
