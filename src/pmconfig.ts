// Per-project package-manager enable/disable: `nps.config.json`.
//
// A project that standardizes on one manager (or never wants brew's
// npm-registry intel mismatch) opts out explicitly:
//
//   {
//     "packageManagers": {
//       "brew": { "enabled": false }
//     }
//   }
//
// Shape rules (fail-open everywhere — a config problem must never break
// installs, it just means "all enabled"):
//   - Missing file, unreadable file, or malformed JSON → all enabled.
//   - Missing/non-object `packageManagers` → all enabled.
//   - Each entry must be an object with a boolean `enabled`; anything
//     else for a manager is ignored (that manager stays enabled).
//   - Unlisted managers are enabled; unknown names are kept verbatim and
//     simply never match a real manager, so typos can't disable anything.
//   - Keys are lowercased/trimmed before matching.
//   - This module never imports pm.ts (it only deals in plain strings),
//     so there is no import cycle with detection.
//
// Works identically under Node, Bun, Deno — only node:fs / node:path.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Config file name, resolved against the project cwd. */
export const CONFIG_FILE = "nps.config.json";

export interface PmEntry {
  enabled: boolean;
}

export interface PmConfig {
  /** per-manager settings keyed by normalized (lowercase) manager name */
  packageManagers: Record<string, PmEntry>;
}

/** Fresh empty config (no shared mutable state). */
function emptyConfig(): PmConfig {
  return { packageManagers: {} };
}

/** Pure parse of an unknown JSON value into a PmConfig. Never throws. */
export function parsePmConfig(raw: unknown): PmConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyConfig();
  const table = (raw as { packageManagers?: unknown }).packageManagers;
  if (!table || typeof table !== "object" || Array.isArray(table)) return emptyConfig();
  const out: Record<string, PmEntry> = {};
  for (const [key, value] of Object.entries(table)) {
    const name = key.trim().toLowerCase();
    if (!name || out[name]) continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const enabled = (value as { enabled?: unknown }).enabled;
    if (typeof enabled !== "boolean") continue;
    out[name] = { enabled };
  }
  return { packageManagers: out };
}

const cache = new Map<string, PmConfig>();

/** Load `<cwd>/nps.config.json` (cached per cwd). Fail-open: all enabled. */
export function loadPmConfig(cwd: string): PmConfig {
  const hit = cache.get(cwd);
  if (hit) return hit;
  let cfg: PmConfig = emptyConfig();
  try {
    cfg = parsePmConfig(JSON.parse(readFileSync(join(cwd, CONFIG_FILE), "utf8")));
  } catch {
    cfg = emptyConfig();
  }
  cache.set(cwd, cfg);
  return cfg;
}

/** Test seam: drop the per-cwd cache. */
export function clearPmConfigCache(): void {
  cache.clear();
}

/** Pure check: true unless `pm` has an explicit `{ enabled: false }` entry. */
export function isPmEnabled(pm: string, cfg: PmConfig): boolean {
  const entry = cfg.packageManagers[pm.trim().toLowerCase()];
  return entry ? entry.enabled : true;
}
