// Private-registry support: .npmrc discovery + `--registry` / token resolution.
// Works identically under Node, Bun, Deno — only node:fs / node:os / process.
//
// Precedence (highest first):
//   registry: `--registry` flag > NPM_CONFIG_REGISTRY/npm_config_registry
//             > .npmrc `registry` (project cwd wins over home) > npmjs default.
//             `@scope:registry` entries always win for their scope.
//   token:    .npmrc `//host/:_authToken` (or `:_auth`) for the host >
//             NPM_TOKEN env (sent as Bearer).
//
// .npmrc values support npm-style ${VAR} interpolation, which is how CI
// commonly injects tokens (`//host/:_authToken=${NPM_TOKEN}`).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export interface NpmrcConfig {
  /** effective default registry (no trailing slash) */
  registry: string;
  /** scope (without @) -> registry */
  scoped: Record<string, string>;
  /** nerfed host key ("//host/") -> bearer token */
  tokens: Record<string, string>;
  /** nerfed host key ("//host/") -> basic-auth value */
  auths: Record<string, string>;
}

/** `https://host:port/path` -> `//host:port/` (the key form npm uses). */
export function nerf(url: string): string {
  try {
    return `//${new URL(url).host}/`;
  } catch {
    return url;
  }
}

function interpolate(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? "");
}

function parseNpmrc(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    out[key] = interpolate(trimmed.slice(eq + 1).trim());
  }
  return out;
}

/** Normalize a `//host…:_authToken` / `:_auth` key to its `//host/` form. */
function hostKey(key: string, suffix: ":_authToken" | ":_auth"): string | null {
  if (!key.endsWith(suffix)) return null;
  const host = key.slice(0, -suffix.length);
  if (!host.startsWith("//")) return null;
  return host.endsWith("/") ? host : `${host}/`;
}

function foldEntries(cfg: NpmrcConfig, entries: Record<string, string>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (!value) continue;
    if (key === "registry") {
      cfg.registry = value.replace(/\/+$/, "");
      continue;
    }
    const scopeMatch = key.match(/^@([^:]+):registry$/);
    if (scopeMatch?.[1]) {
      cfg.scoped[scopeMatch[1]] = value.replace(/\/+$/, "");
      continue;
    }
    const tokenHost = hostKey(key, ":_authToken");
    if (tokenHost) {
      cfg.tokens[tokenHost] = value;
      continue;
    }
    const authHost = hostKey(key, ":_auth");
    if (authHost) {
      cfg.auths[authHost] = value;
    }
  }
}

function readNpmrcFile(path: string): Record<string, string> {
  try {
    return parseNpmrc(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function homeDir(): string {
  // $HOME first (explicit and honors test/CI overrides); os.homedir() as fallback.
  const envHome = process.env.HOME || process.env.USERPROFILE;
  if (envHome) return envHome;
  try {
    return homedir();
  } catch {
    return "";
  }
}

function loadUncached(cwd: string): NpmrcConfig {
  const cfg: NpmrcConfig = { registry: DEFAULT_REGISTRY, scoped: {}, tokens: {}, auths: {} };
  // Home first so the project file wins per key.
  const home = homeDir();
  if (home) foldEntries(cfg, readNpmrcFile(join(home, ".npmrc")));
  foldEntries(cfg, readNpmrcFile(join(cwd, ".npmrc")));
  return cfg;
}

const cache = new Map<string, NpmrcConfig>();

/** Load and merge home + project .npmrc (project wins). Cached per cwd. */
export function loadNpmrc(cwd: string): NpmrcConfig {
  const hit = cache.get(cwd);
  if (hit) return hit;
  const cfg = loadUncached(cwd);
  cache.set(cwd, cfg);
  return cfg;
}

/** Registry URL (no trailing slash) for a package name. */
export function registryFor(
  name: string,
  cfg: NpmrcConfig,
  override?: string | null,
): string {
  if (override) return override.replace(/\/+$/, "");
  const env = process.env.NPM_CONFIG_REGISTRY ?? process.env.npm_config_registry;
  if (name.startsWith("@")) {
    const scope = name.slice(1).split("/")[0];
    if (scope && cfg.scoped[scope]) return cfg.scoped[scope]!;
  }
  if (env) return env.replace(/\/+$/, "");
  return cfg.registry;
}

/** `Authorization` header for a registry URL, or {} when anonymous. */
export function authHeaders(registryUrl: string, cfg: NpmrcConfig): Record<string, string> {
  const host = nerf(registryUrl);
  // Exact host key first, then any path-scoped key under the same host.
  const token =
    cfg.tokens[host] ??
    Object.entries(cfg.tokens)
      .filter(([k]) => host.startsWith(k) || k.startsWith(host))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1];
  if (token) return { Authorization: `Bearer ${token}` };
  const auth =
    cfg.auths[host] ??
    Object.entries(cfg.auths)
      .filter(([k]) => host.startsWith(k) || k.startsWith(host))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1];
  if (auth) return { Authorization: `Basic ${auth}` };
  const envToken = process.env.NPM_TOKEN;
  if (envToken) return { Authorization: `Bearer ${envToken}` };
  return {};
}

/**
 * Flat `//host/:_authToken` / `@scope:registry` option keys for Arborist —
 * the same shape npm itself layers over .npmrc (Arborist never reads .npmrc;
 * pacote's npm-registry-fetch consumes these keys downstream).
 */
export function arboristRegistryOpts(
  cfg: NpmrcConfig,
  override?: string | null,
): Record<string, string> {
  const opts: Record<string, string> = {};
  const registries = new Set<string>([
    cfg.registry,
    ...Object.values(cfg.scoped),
    ...(override ? [override.replace(/\/+$/, "")] : []),
  ]);
  opts["registry"] = override ? override.replace(/\/+$/, "") : cfg.registry;
  for (const [scope, url] of Object.entries(cfg.scoped)) {
    opts[`@${scope}:registry`] = url;
  }
  for (const url of registries) {
    const headers = authHeaders(url, cfg);
    const header = headers["Authorization"];
    if (!header) continue;
    if (header.startsWith("Bearer ")) {
      opts[`${nerf(url)}:_authToken`] = header.slice("Bearer ".length);
    } else if (header.startsWith("Basic ")) {
      opts[`${nerf(url)}:_auth`] = header.slice("Basic ".length);
    }
  }
  return opts;
}
