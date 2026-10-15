export interface NpmMeta {
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  repoUrl: string;
  directDeps: string[];
  maintainers: string[];
  /** deprecation message from the registry; absent/null = not deprecated */
  deprecated?: string | null;
  /** lifecycle scripts that run on install (preinstall/install/postinstall) */
  installScripts?: string[];
  /** true when served from an expired cache entry because the live fetch failed */
  stale?: boolean;
}

export interface HealthBreakdown {
  security: string;
  popularity: string;
  maintenance: string;
  community: string;
}

export interface Health {
  score: number | null; // 0-100, null when snyk unreachable
  breakdown: HealthBreakdown | null;
  /** true when snyk answered 200 but the page had no parseable markers
      (layout change / bot wall) — unknown health, not healthy */
  unparsed?: boolean;
  /** true when served from an expired cache entry because the live fetch failed */
  stale?: boolean;
  /** true when health lookup was switched off (--no-snyk / config) */
  skipped?: boolean;
}

/** Known advisories for the inspected version (OSV.dev). */
export interface Vulns {
  count: number;
  /** advisory ids (GHSA-…, CVE-…), capped for display */
  ids: string[];
  /** highest severity label seen, when the source states one */
  worst: "critical" | "high" | "moderate" | "low" | null;
  stale?: boolean;
}

/** Cheap local red flags derived from registry metadata. */
export interface Signals {
  deprecated: string | null;
  installScripts: string[];
  /** popular package this name looks like (possible typosquat), else null */
  lookalike: string | null;
  /** fewer than LOW_DOWNLOADS weekly downloads (rarely used, easy to impersonate) */
  lowDownloads?: boolean;
}

export interface PackageReport {
  query: string;
  meta: NpmMeta | null;
  metaError: string | null;
  health: Health;
  directCount: number;
  transitiveCount: number;
  totalCount: number;
  transitiveNames: string[];
  /** true when the transitive crawl hit its node or time budget */
  truncated: boolean;
  elapsedMs: number;
  /** True for non-registry specs (GitHub shorthand, file:, link:, tarball URLs) */
  isNonRegistry?: boolean;
  /** OSV advisories; null = source unreachable, absent = not queried */
  vulns?: Vulns | null;
  signals?: Signals | null;
  /** weekly npm downloads; null = unknown/not applicable, absent = not queried */
  downloads?: number | null;
  /** any source answered from an expired cache (offline fallback) */
  stale?: boolean;
}

export interface CliOptions {
  packages: string[];
  /** unknown flags forwarded verbatim to the package manager */
  extraArgs: string[];
  showAll: boolean;
  yes: boolean;
  dev: boolean;
  peer: boolean;
  optional: boolean;
  /** target workspace package (`-w/--workspace`); null = current project */
  workspace: string | null;
  /** custom registry URL (`--registry`); null = .npmrc/env/default chain */
  registry: string | null;
  dryRun: boolean;
  json: boolean;
  pmOverride: string | null;
  /** `--min-score N`: block when health < N or unknown; null = unset */
  minScore: number | null;
  verbose: boolean;
  noCache: boolean;
  noColor: boolean;
  /** `--no-snyk`: skip the Snyk health scrape (OSV/registry signals still run) */
  noSnyk: boolean;
}

export interface InstallRequest {
  cwd: string;
  /** original user queries, e.g. ["express@5", "@scope/pkg"] */
  packages: string[];
  dev: boolean;
  peer: boolean;
  optional: boolean;
  /** target workspace package; null = current project */
  workspace: string | null;
  /** custom registry URL (`--registry`); null = .npmrc/env/default chain */
  registry: string | null;
  /** extras the user passed; known ones are mapped to engine options */
  extraArgs: string[];
  dryRun: boolean;
}

export interface InstallResult {
  ok: boolean;
  message: string;
}
