// Verbose diagnostics (`--verbose`). Goes to stderr so `--json` stdout stays
// machine-readable. Silent unless enabled; formatting lives here only.
import { c, paint } from "./colors.ts";

let enabled = false;

export function setVerbose(on: boolean): void {
  enabled = on;
}

export function isVerbose(): boolean {
  return enabled;
}

/** Dim `· message` line on stderr when --verbose is on. */
export function vlog(message: string): void {
  if (enabled) console.error(paint(c.dim, `  · ${message}`));
}
