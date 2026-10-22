// Third intel source: deps.dev (Google Open Source Insights), free, no key.
// Structured JSON for an exact name@version, then its source repo:
//   GET https://api.deps.dev/v3/systems/npm/packages/:name/versions/:version
//     -> publishedAt, slsaProvenances/attestations, relatedProjects
//   GET https://api.deps.dev/v3/projects/:projectKey
//     -> OpenSSF Scorecard (overall + per-check), stars, forks
// Public npm only (deps.dev mirrors registry.npmjs.org). Fail-open like every
// intel source: null = unreachable/unknown, never a crash.
import type { Project } from "./types.ts";
import { fetchWithRetry } from "./fetch.ts";
import { CACHE_VERSION, getCache, getCacheStale, META_TTL_MS, setCache } from "./cache.ts";
import { isValidPkgName } from "./spec.ts";
import { vlog } from "./log.ts";
import { VERSION } from "./version.ts";

export const DEPSDEV_API = "https://api.deps.dev/v3";
const MAX_BYTES = 2_000_000;

function depsdevKey(name: string, version: string): string {
  return `depsdev:${CACHE_VERSION}:${name.toLowerCase()}@${version}`;
}

/** "github.com/org/repo" from a repo URL; null for anything else. */
export function repoKeyOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = url.match(
    /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/i,
  );
  return m ? `github.com/${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** Pure: the package-version document's fields we keep, plus the repo to look up. */
export function summarizeVersion(
  body: unknown,
): Omit<Project, "scorecard" | "maintained" | "stars"> {
  const d = (body ?? {}) as Record<string, any>;
  const published = typeof d.publishedAt === "string" && d.publishedAt ? d.publishedAt : null;
  const related = Array.isArray(d.relatedProjects) ? d.relatedProjects : [];
  const source =
    related.find((p: any) => p?.relationType === "SOURCE_REPO") ??
    related.find((p: any) => typeof p?.projectKey?.id === "string");
  const repo = repoKeyOf(source?.projectKey?.id ? `https://${source.projectKey.id}` : null);
  const attest = [
    ...(Array.isArray(d.slsaProvenances) ? d.slsaProvenances : []),
    ...(Array.isArray(d.attestations) ? d.attestations : []),
  ].filter((a: any) => a?.verified === true);
  // Provenance pins the build to a repo; it also proves the repo claim
  // (anyone can point `repository` at a popular project to borrow its stars).
  const builtFrom = attest.map((a: any) => repoKeyOf(a?.sourceRepository)).find(Boolean) ?? null;
  return {
    publishedAt: published,
    provenance: attest.length > 0,
    repo,
    repoVerified: repo !== null && builtFrom === repo,
  };
}

/** Pure: Scorecard overall (0-10), its Maintained check, and stars. */
export function summarizeProject(
  body: unknown,
): Pick<Project, "scorecard" | "maintained" | "stars"> {
  const d = (body ?? {}) as Record<string, any>;
  const sc = d.scorecard && typeof d.scorecard === "object" ? d.scorecard : null;
  const overall = typeof sc?.overallScore === "number" ? sc.overallScore : null;
  const checks = Array.isArray(sc?.checks) ? sc.checks : [];
  const m = checks.find((c: any) => c?.name === "Maintained")?.score;
  return {
    scorecard: overall !== null && overall >= 0 && overall <= 10 ? overall : null,
    // Scorecard uses -1 for "could not determine".
    maintained: typeof m === "number" && m >= 0 && m <= 10 ? m : null,
    stars: typeof d.starsCount === "number" && d.starsCount >= 0 ? d.starsCount : null,
  };
}

const inflight = new Map<string, Promise<Project | null>>();

export function clearDepsDevInflight(): void {
  inflight.clear();
}

async function getJson(url: string): Promise<unknown | null> {
  const res = await fetchWithRetry(
    url,
    { headers: { Accept: "application/json", "User-Agent": `nps/${VERSION}` } },
    { timeoutMs: 6000 },
  );
  // 404 = deps.dev hasn't indexed it (brand-new publish, unknown repo): no data.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`deps.dev responded ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error("deps.dev response too large");
  return JSON.parse(text);
}

export async function fetchProject(name: string, version: string): Promise<Project | null> {
  if (!isValidPkgName(name) || !version || version === "n/a") return null;
  const key = depsdevKey(name, version);
  const cached = getCache<Project>(key);
  if (cached) {
    vlog(`cache hit: ${name}@${version} (deps.dev)`);
    return cached;
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async (): Promise<Project | null> => {
    vlog(`cache miss: ${name}@${version} (deps.dev) -> api.deps.dev`);
    try {
      const doc = await getJson(
        `${DEPSDEV_API}/systems/npm/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
      );
      if (doc === null) return null;
      const ver = summarizeVersion(doc);
      let proj: Pick<Project, "scorecard" | "maintained" | "stars"> = {
        scorecard: null,
        maintained: null,
        stars: null,
      };
      let partial = false;
      if (ver.repo) {
        // A repo lookup failure keeps the version facts (partial, not empty)
        // but is not cached, so the next run tries the repo again.
        try {
          const body = await getJson(`${DEPSDEV_API}/projects/${encodeURIComponent(ver.repo)}`);
          if (body !== null) proj = summarizeProject(body);
        } catch (err) {
          partial = true;
          vlog(
            `${ver.repo}: deps.dev project failed (${err instanceof Error ? err.message : err})`,
          );
        }
      }
      const out: Project = { ...ver, ...proj };
      if (!partial) setCache(key, out, META_TTL_MS);
      return out;
    } catch (err) {
      const old = getCacheStale<Project>(key);
      vlog(
        `${name}@${version}: deps.dev failed (${err instanceof Error ? err.message : err})${old ? " — using stale cache" : ""}`,
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
