export interface NpmMeta {
  name: string;
  version: string;
  description: string;
  author: string;
  license: string;
  repoUrl: string;
  directDeps: string[];
  maintainers: string[];
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
  elapsedMs: number;
  /** True for non-registry specs (GitHub shorthand, file:, link:, tarball URLs) */
  isNonRegistry?: boolean;
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
