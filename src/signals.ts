// Cheap, local red flags derived from registry metadata — no extra network.
import type { NpmMeta, Signals } from "./types.ts";
import { LOW_DOWNLOADS } from "./downloads.ts";
import { POPULAR } from "./popular.ts";

const POPULAR_SET = new Set(POPULAR);

/** Versions younger than this get a "fresh release" warning. */
export const FRESH_HOURS = 48;

/** Hours since an ISO time; null when unknown/unparsable. Pure. */
export function hoursSince(iso: string | null | undefined, now = Date.now()): number | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, (now - t) / 3_600_000) : null;
}

/** Damerau-free Levenshtein with an early-out bound. Pure. */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * Popular package this name is suspiciously close to, else null. Exact
 * matches are the real thing. Names under 5 chars are skipped (too noisy),
 * and the edit budget is 1 for short names, 2 from 8 chars.
 */
export function lookalikeOf(name: string): string | null {
  const bare = name.toLowerCase().replace(/^@[^/]+\//, "");
  if (bare.length < 5 || POPULAR_SET.has(bare)) return null;
  const budget = bare.length >= 8 ? 2 : 1;
  let best: string | null = null;
  let bestD = budget + 1;
  for (const p of POPULAR) {
    const d = editDistance(bare, p, budget);
    if (d <= budget && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

export function signalsOf(
  meta: NpmMeta,
  downloads: number | null = null,
  publishedAt: string | null = null,
  now = Date.now(),
): Signals {
  const age = hoursSince(publishedAt, now);
  return {
    lowDownloads: downloads !== null && downloads < LOW_DOWNLOADS,
    freshRelease: age !== null && age < FRESH_HOURS,
    noRepo: !meta.repoUrl || meta.repoUrl === "n/a",
    deprecated: meta.deprecated ?? null,
    installScripts: meta.installScripts ?? [],
    // Scoped packages live in someone's namespace: not a lookalike of an unscoped name.
    lookalike: meta.name.startsWith("@") ? null : lookalikeOf(meta.name),
  };
}

/** Closest word in `candidates` within 2 edits, for CLI "did you mean". */
export function closest(word: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const cand of candidates) {
    const d = editDistance(word.toLowerCase(), cand, 2);
    if (d < bestD) {
      best = cand;
      bestD = d;
    }
  }
  return best;
}
