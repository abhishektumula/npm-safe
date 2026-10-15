// Process exit codes — stable contract for CI and scripts (see README).
export const EXIT = {
  /** success (including a user declining the prompt) */
  OK: 0,
  /** generic failure: bad flags, install error, unsupported combination */
  ERROR: 1,
  /** blocked by policy (--min-score, nps.config.json policy) */
  BLOCKED: 3,
  /** intel unavailable: every lookup failed (offline, registry down) */
  UNAVAILABLE: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
