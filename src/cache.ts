// Persistent intel cache: memory + disk, TTL-based.
//
// Why this exists: `nps install express` fans out to 60+ `/:pkg/latest`
// fetches (direct + transitive BFS) plus a Snyk scrape. Cold that is
// seconds of TLS + CDN latency — a single `/latest` is already ~50-100ms,
// so ~50ms total is only reachable warm. This module gives us that warm
// path: successful registry + health lookups are cached on disk
// (XDG_CACHE_HOME or ~/.cache) with a 24h TTL, so repeat installs return
// from memory/disk in single-digit ms with zero network.
//
// Design notes:
// - Two tiers: process-memory Map (fastest) fronting a JSON file on disk.
// - Disk reads happen once per process (lazy); writes are fire-and-forget
//   async so they never block the intel return path.
// - Failures (404, network errors) are never cached — only successes.
// - Keys are versioned (`v1`) and include the registry URL for meta so a
//   `--registry` run never reuses public data.
// - Disabled via `NPS_NO_CACHE=1|true|off` (tests use this) or
//   `NPS_CACHE_DIR` override for isolation. No Bun.* APIs — Node ≥18 safe.

import { mkdirSync, readFileSync, rmSync, writeFile, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

export const CACHE_VERSION = "v1";
export const META_TTL_MS = 24 * 3600 * 1000;
export const HEALTH_TTL_MS = 24 * 3600 * 1000;
export const OSV_TTL_MS = 24 * 3600 * 1000;
/** Expired entries stay on disk this long so an offline run can still answer. */
export const STALE_WINDOW_MS = 7 * 24 * 3600 * 1000;
const MAX_ENTRIES = 2000;
const FLUSH_DEBOUNCE_MS = 200;

interface Entry {
  exp: number;
  data: unknown;
}

const mem = new Map<string, Entry>();
const disk = new Map<string, Entry>();
let diskLoaded = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function isDiskCacheEnabled(): boolean {
  const v = (process.env.NPS_NO_CACHE ?? "").toLowerCase();
  return v !== "1" && v !== "true" && v !== "off";
}

export function getCacheDir(): string {
  const override = process.env.NPS_CACHE_DIR;
  if (override) return override;
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return join(xdg, "nps");
  try {
    const home = process.env.HOME || process.env.USERPROFILE || homedir();
    if (home) return join(home, ".cache", "nps");
  } catch {
    /* fall through */
  }
  return join(tmpdir(), "nps-cache");
}

export function getCacheFile(): string {
  return join(getCacheDir(), `intel-cache-${CACHE_VERSION}.json`);
}

function loadDiskOnce(): void {
  if (diskLoaded || !isDiskCacheEnabled()) return;
  diskLoaded = true;
  let raw: string;
  try {
    raw = readFileSync(getCacheFile(), "utf8");
  } catch {
    return;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, Entry>;
    const now = Date.now();
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v.exp === "number" && v.exp + STALE_WINDOW_MS > now) {
        disk.set(k, v);
        if (disk.size >= MAX_ENTRIES) break;
      }
    }
  } catch {
    // Corrupt cache file — ignore, it gets overwritten on next flush.
  }
}

function scheduleFlush(): void {
  if (!isDiskCacheEnabled()) return;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushDisk();
  }, FLUSH_DEBOUNCE_MS);
  // Don't keep the process alive just for a cache write.
  (flushTimer as unknown as { unref?: () => void }).unref?.();
}

/** Drop everything but the MAX_ENTRIES freshest (largest expiry) entries. */
function trimToFreshest(merged: Record<string, Entry>, keys: string[]): void {
  const doomed = keys.sort((a, b) => (merged[a]!.exp < merged[b]!.exp ? 1 : -1)).slice(MAX_ENTRIES);
  for (const k of doomed) delete merged[k];
}

function flushDisk(): void {
  if (!isDiskCacheEnabled()) return;
  let file: string;
  try {
    file = getCacheFile();
    mkdirSync(getCacheDir(), { recursive: true });
  } catch {
    return;
  }
  // Merge memory (fresh) over disk, drop expired, cap size.
  const now = Date.now();
  const merged: Record<string, Entry> = {};
  for (const [k, v] of disk) {
    if (v.exp + STALE_WINDOW_MS > now) merged[k] = v;
  }
  for (const [k, v] of mem) {
    if (v.exp + STALE_WINDOW_MS > now) merged[k] = v;
  }
  const keys = Object.keys(merged);
  if (keys.length > MAX_ENTRIES) {
    // Keep the freshest entries (largest expiry).
    trimToFreshest(merged, keys);
  }
  const body = JSON.stringify(merged);
  writeFile(file, body, () => {});
}

/**
 * Synchronous persist for short-lived CLI processes. `setCache` alone only
 * schedules an async flush (debounced) so a 60-node crawl doesn't do 60
 * disk writes; but `bun -e` / `nps install` exits right after intel, which
 * would lose the last writes. Callers flush once after all intel settles —
 * warm hits do zero writes, so this costs nothing on the ~50ms path.
 */
export function persistIntelCacheSync(): void {
  if (!isDiskCacheEnabled()) return;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    mkdirSync(getCacheDir(), { recursive: true });
  } catch {
    return;
  }
  try {
    const now = Date.now();
    const merged: Record<string, Entry> = {};
    for (const [k, v] of disk) {
      if (v.exp + STALE_WINDOW_MS > now) merged[k] = v;
    }
    for (const [k, v] of mem) {
      if (v.exp + STALE_WINDOW_MS > now) merged[k] = v;
    }
    const keys = Object.keys(merged);
    if (keys.length > MAX_ENTRIES) {
      trimToFreshest(merged, keys);
    }
    writeFileSync(getCacheFile(), JSON.stringify(merged));
  } catch {
    /* cache must never break intel */
  }
}

/** Fast sync read: memory first, then disk (promotes on hit). Null on miss/expiry. */
export function getCache<T>(key: string): T | null {
  const now = Date.now();
  const m = mem.get(key);
  if (m) {
    if (m.exp > now) return m.data as T;
    mem.delete(key);
  }
  if (!isDiskCacheEnabled()) return null;
  loadDiskOnce();
  const d = disk.get(key);
  if (d) {
    if (d.exp > now) {
      // Promote to memory for next hit.
      if (mem.size >= MAX_ENTRIES) mem.clear();
      mem.set(key, d);
      return d.data as T;
    }
  }
  return null;
}

/**
 * Offline fallback: an expired entry (within STALE_WINDOW_MS) or a fresh one.
 * Only call this after a live fetch failed — callers must label the result
 * as cached/stale. Null when absent or older than the stale window.
 */
export function getCacheStale<T>(key: string): T | null {
  if (!isDiskCacheEnabled()) return null;
  loadDiskOnce();
  const now = Date.now();
  const d = mem.get(key) ?? disk.get(key);
  if (d && d.exp + STALE_WINDOW_MS > now) return d.data as T;
  return null;
}

/** Store in memory + schedule an async disk flush. Never throws. */
export function setCache(key: string, data: unknown, ttlMs: number): void {
  const entry: Entry = { exp: Date.now() + ttlMs, data };
  try {
    if (mem.size >= MAX_ENTRIES) mem.clear();
    mem.set(key, entry);
    if (isDiskCacheEnabled()) {
      loadDiskOnce();
      if (disk.size >= MAX_ENTRIES) disk.clear();
      disk.set(key, entry);
      scheduleFlush();
    }
  } catch {
    /* cache must never break intel */
  }
}

export interface CacheStats {
  enabled: boolean;
  dir: string;
  file: string;
  entries: number;
  bytes: number;
}

/** Read-only snapshot for `nps doctor`. */
export function cacheStats(): CacheStats {
  const file = getCacheFile();
  let bytes = 0;
  let entries = 0;
  try {
    const raw = readFileSync(file, "utf8");
    bytes = Buffer.byteLength(raw);
    entries = Object.keys(JSON.parse(raw) as object).length;
  } catch {
    /* absent or corrupt: report zeros */
  }
  return { enabled: isDiskCacheEnabled(), dir: getCacheDir(), file, entries, bytes };
}

/** `nps cache-clear`: drop memory and delete the on-disk file. Returns entries removed. */
export function purgeIntelCache(): number {
  const before = cacheStats().entries;
  mem.clear();
  disk.clear();
  diskLoaded = true;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    rmSync(getCacheFile(), { force: true });
  } catch {
    /* nothing to remove */
  }
  return before;
}

/** Clear memory + in-process disk view and remove the file. Tests use this. */
export function clearIntelCache(): void {
  mem.clear();
  disk.clear();
  diskLoaded = true; // stay empty — don't reload stale file after a test clear
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!isDiskCacheEnabled()) return;
  try {
    mkdirSync(getCacheDir(), { recursive: true });
    writeFileSync(getCacheFile(), "{}");
  } catch {
    /* ignore */
  }
}

export function metaKey(registry: string, name: string): string {
  return `meta:${CACHE_VERSION}:${registry}:${name.toLowerCase()}`;
}

export function healthKey(name: string): string {
  return `health:${CACHE_VERSION}:${name.toLowerCase()}`;
}

export function osvKey(name: string, version: string): string {
  return `osv:${CACHE_VERSION}:${name.toLowerCase()}@${version}`;
}
