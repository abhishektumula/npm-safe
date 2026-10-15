import type { NpmMeta } from "./types.ts";
import { fetchWithRetry } from "./fetch.ts";
import { getCache, getCacheStale, metaKey, META_TTL_MS, setCache } from "./cache.ts";
import { encodePkg, isValidPkgName } from "./spec.ts";
import { vlog } from "./log.ts";
import { authHeaders, loadNpmrc, nerf, registryFor } from "./npmrc.ts";

export interface FetchMetaOptions {
  /** `--registry` override (flag wins over .npmrc and env) */
  registry?: string | null;
  /** project dir for .npmrc discovery (defaults to process.cwd()) */
  cwd?: string;
}

function cleanRepoUrl(raw: unknown): string {
  if (!raw) return "n/a";
  const url = typeof raw === "string" ? raw : ((raw as { url?: string }).url ?? "");
  if (!url) return "n/a";
  return url
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
}

function cleanAuthor(raw: unknown): string {
  if (!raw) return "n/a";
  if (typeof raw === "string") return raw || "n/a";
  const a = raw as { name?: string; email?: string };
  return a.name || a.email || "n/a";
}

const INSTALL_HOOKS = ["preinstall", "install", "postinstall"] as const;

/** Lifecycle scripts that execute code on the installer's machine. */
export function installScriptsOf(doc: Record<string, any>): string[] {
  const scripts = doc.scripts && typeof doc.scripts === "object" ? doc.scripts : {};
  const found: string[] = INSTALL_HOOKS.filter((h) => typeof scripts[h] === "string" && scripts[h]);
  // node-gyp builds run implicitly when binding.gyp exists and no install script is set.
  if (doc.gypfile === true && !found.includes("install")) found.push("install");
  return found;
}

// Fast path: /:pkg/latest is a few KB vs multi-MB full packument.
// Same data that powers npmjs.com/package/:pkg, minus the HTML weight.
// Private registries work via `--registry`, .npmrc (`registry`,
// `@scope:registry`, `//host/:_authToken` with ${VAR} interpolation),
// or the NPM_TOKEN env var.
//
// Warm path: successful lookups are cached (memory + disk, 24h TTL) so
// repeat installs return in single-digit ms with zero network. Concurrent
// callers for the same package share one in-flight fetch (deduped), which
// is what makes `nps install express lodash` truly parallel when their
// transitive graphs overlap.
const inflight = new Map<string, Promise<NpmMeta>>();

export function clearNpmInflight(): void {
  inflight.clear();
}

export async function fetchNpmMeta(name: string, opts?: FetchMetaOptions): Promise<NpmMeta> {
  if (!isValidPkgName(name)) {
    throw new Error(`invalid package name "${name}": registry names only (no protocols or paths)`);
  }
  const cfg = loadNpmrc(opts?.cwd ?? process.cwd());
  const registry = registryFor(name, cfg, opts?.registry);
  const key = metaKey(registry, name);
  const cached = getCache<NpmMeta>(key);
  if (cached) {
    vlog(`cache hit: ${name} (meta)`);
    return cached;
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async (): Promise<NpmMeta> => {
    // Transient failures (network, 5xx) fall back to an expired cache entry,
    // labelled stale. 404/401/403 are definitive and never fall back.
    const staleFallback = (why: string): NpmMeta | null => {
      const old = getCacheStale<NpmMeta>(key);
      if (!old) return null;
      vlog(`${name}: ${why} — using stale cache`);
      return { ...old, stale: true };
    };
    vlog(`cache miss: ${name} (meta) -> ${registry}`);
    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetchWithRetry(
        `${registry}/${encodePkg(name)}/latest`,
        { headers: { Accept: "application/json", ...authHeaders(registry, cfg) } },
        { timeoutMs: 8000 },
      );
    } catch (err) {
      const fallback = staleFallback("registry unreachable");
      if (fallback) return fallback;
      throw err;
    }
    vlog(`${name}: registry ${res.status} in ${Date.now() - t0}ms`);
    if (res.status === 404) throw new Error(`package "${name}" not found (${nerf(registry)})`);
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `registry responded ${res.status} for "${name}" — private registry? set NPM_TOKEN or check .npmrc auth for ${nerf(registry)}`,
      );
    }
    if (!res.ok) {
      if (res.status >= 500) {
        const fallback = staleFallback(`registry ${res.status}`);
        if (fallback) return fallback;
      }
      throw new Error(`registry responded ${res.status}`);
    }
    const j = (await res.json()) as Record<string, any>;
    const deps =
      j.dependencies && typeof j.dependencies === "object" ? Object.keys(j.dependencies) : [];
    const meta: NpmMeta = {
      name: j.name ?? name,
      version: j.version ?? "n/a",
      description: j.description ?? "",
      author: cleanAuthor(j.author),
      license: typeof j.license === "string" ? j.license : (j.license?.type ?? "n/a"),
      repoUrl: cleanRepoUrl(j.repository),
      directDeps: deps,
      maintainers: Array.isArray(j.maintainers)
        ? j.maintainers.map((m: any) => m.name).filter(Boolean)
        : [],
      deprecated: typeof j.deprecated === "string" && j.deprecated ? j.deprecated : null,
      installScripts: installScriptsOf(j),
    };
    // Only successes are cached — 404/auth/5xx always revalidate.
    setCache(key, meta, META_TTL_MS);
    return meta;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    if (inflight.get(key) === p) inflight.delete(key);
  }
}
