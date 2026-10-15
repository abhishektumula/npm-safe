import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, isPmEnabled, loadPmConfig } from "./pmconfig.ts";

export type Pm = "bun" | "pnpm" | "npm" | "yarn" | "brew";

/** Every manager nps can route to. `brew` is opt-in only (--pm brew). */
export const ALL_PMS = ["bun", "pnpm", "npm", "yarn", "brew"] as const;

export class PmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PmError";
  }
}

/** True for exactly the managers nps can route to (see ALL_PMS). */
export function isSupportedPm(value: string): value is Pm {
  return (ALL_PMS as readonly string[]).includes(value);
}

// NOTE: installs no longer shell out with per-PM argv (see install.ts —
// npm/yarn run in-process via their official engines). This module only
// detects which manager owns the current directory.

// Local-only, read-only detection — never touches globals.
// Mirrors: [ -f pnpm-lock.yaml ] / yarn.lock / package-lock.json / bun.lock
// First match wins, in that order. Falls back to the packageManager field,
// then npm. Brew is never auto-selected (not a JS installer); --pm brew
// is opt-in.
export function detectPm(override: string | null): { pm: Pm; via: string } {
  const cwd = process.cwd();
  let result: { pm: Pm; via: string };
  if (override) {
    const pm = override.toLowerCase();
    // Fail fast on unknown managers: the engines also guard, but routing
    // must never depend on a downstream switch to reject an arbitrary
    // binary name.
    if (!isSupportedPm(pm)) {
      throw new PmError(
        `unsupported package manager: "${override}" (supported: ${ALL_PMS.join(", ")})`,
      );
    }
    result = { pm, via: "flag --pm" };
  } else if (existsSync(join(cwd, "pnpm-lock.yaml"))) {
    result = { pm: "pnpm", via: "pnpm-lock.yaml" };
  } else if (existsSync(join(cwd, "yarn.lock"))) {
    result = { pm: "yarn", via: "yarn.lock" };
  } else if (existsSync(join(cwd, "package-lock.json"))) {
    result = { pm: "npm", via: "package-lock.json" };
  } else if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) {
    result = { pm: "bun", via: "bun.lock" };
  } else {
    const fromField = readPackageManagerField(cwd);
    result = fromField
      ? { pm: fromField, via: "packageManager field" }
      : { pm: "npm", via: "default" };
  }
  // nps.config.json opt-outs apply to every route — flag, lockfile, field,
  // default. Disabled managers fail here, before any intel or install.
  if (!isPmEnabled(result.pm, loadPmConfig(cwd))) {
    throw new PmError(
      `package manager "${result.pm}" is disabled (${CONFIG_FILE} > packageManagers > ${result.pm})`,
    );
  }
  return result;
}

function readPackageManagerField(cwd: string): Pm | null {
  try {
    const raw = readFileSync(join(cwd, "package.json"), "utf8");
    const field = (JSON.parse(raw) as { packageManager?: unknown }).packageManager;
    if (typeof field !== "string") return null;
    const name = field.split("@")[0]!.toLowerCase();
    return isSupportedPm(name) && name !== "brew" ? name : null;
  } catch {
    return null;
  }
}
