// Stable machine-readable output for --json. Bump SCHEMA_VERSION on any
// breaking change to this shape; documented in docs/json-schema.md.
import { VERSION } from "./version.ts";
import type { Policy, Violation } from "./policy.ts";
import { isActive } from "./policy.ts";
import type { PackageReport } from "./types.ts";

export const SCHEMA_VERSION = 1;

export interface JsonReport {
  schemaVersion: number;
  nps: string;
  command: "install" | "check" | "scan";
  policy: {
    active: boolean;
    minScore: number | null;
    violations: Violation[];
    /** false means nps exits 3 (blocked) */
    passed: boolean;
  };
  packages: PackageReport[];
}

export function buildJsonReport(
  command: JsonReport["command"],
  packages: PackageReport[],
  policy: Policy,
  violations: Violation[],
): JsonReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    nps: VERSION,
    command,
    policy: {
      active: isActive(policy),
      minScore: policy.minScore,
      violations,
      passed: violations.length === 0,
    },
    packages,
  };
}
