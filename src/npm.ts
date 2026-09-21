import type { NpmMeta } from "./types.ts";
import { fetchWithRetry } from "./fetch.ts";
import { encodePkg, isValidPkgName } from "./spec.ts";

const REGISTRY = "https://registry.npmjs.org";

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
export async function fetchNpmMeta(name: string): Promise<NpmMeta> {
  if (!isValidPkgName(name)) {
    throw new Error(`invalid package name "${name}": registry names only (no protocols or paths)`);
  }
  const res = await fetchWithRetry(
    `${REGISTRY}/${encodePkg(name)}/latest`,
    { headers: { Accept: "application/json" } },
    { timeoutMs: 8000 },
  );
  if (res.status === 404) throw new Error(`package "${name}" not found on npm`);
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
