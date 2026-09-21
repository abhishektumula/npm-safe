import type { NpmMeta } from "./types.ts";
import { encodePkg } from "./spec.ts";
import { authHeaders, loadNpmrc, nerf, registryFor } from "./npmrc.ts";

export interface FetchMetaOptions {
  /** `--registry` override (flag wins over .npmrc and env) */
  registry?: string | null;
  /** project dir for .npmrc discovery (defaults to process.cwd()) */
  cwd?: string;
}

function cleanRepoUrl(raw: unknown): string {
  if (!raw) return "n/a";
  const url = typeof raw === "string" ? raw : (raw as { url?: string }).url ?? "";
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

// Fast path: /:pkg/latest is a few KB vs multi-MB full packument.
// Same data that powers npmjs.com/package/:pkg, minus the HTML weight.
// Private registries work via `--registry`, .npmrc (`registry`,
// `@scope:registry`, `//host/:_authToken` with ${VAR} interpolation),
// or the NPM_TOKEN env var.
export async function fetchNpmMeta(name: string, opts?: FetchMetaOptions): Promise<NpmMeta> {
  const cfg = loadNpmrc(opts?.cwd ?? process.cwd());
  const registry = registryFor(name, cfg, opts?.registry);
  const res = await fetch(`${registry}/${encodePkg(name)}/latest`, {
    headers: { Accept: "application/json", ...authHeaders(registry, cfg) },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) throw new Error(`package "${name}" not found (${nerf(registry)})`);
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `registry responded ${res.status} for "${name}" — private registry? set NPM_TOKEN or check .npmrc auth for ${nerf(registry)}`,
    );
  }
  if (!res.ok) throw new Error(`registry responded ${res.status}`);
  const j = (await res.json()) as Record<string, any>;
  const deps = j.dependencies && typeof j.dependencies === "object" ? Object.keys(j.dependencies) : [];
  return {
    name: j.name ?? name,
    version: j.version ?? "n/a",
    description: j.description ?? "",
    author: cleanAuthor(j.author),
    license: typeof j.license === "string" ? j.license : (j.license?.type ?? "n/a"),
    repoUrl: cleanRepoUrl(j.repository),
    directDeps: deps,
    maintainers: Array.isArray(j.maintainers) ? j.maintainers.map((m: any) => m.name).filter(Boolean) : [],
  };
}
