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
}

export interface CliOptions {
  packages: string[];
  /** unknown flags forwarded verbatim to the package manager */
  extraArgs: string[];
  showAll: boolean;
  yes: boolean;
  dev: boolean;
  dryRun: boolean;
  json: boolean;
  pmOverride: string | null;
}
