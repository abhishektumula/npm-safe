import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Pm = "bun" | "pnpm" | "npm" | "yarn" | "brew";

/** Every manager npms can route to. `brew` is opt-in only (--pm brew). */
export const ALL_PMS = ["bun", "pnpm", "npm", "yarn", "brew"] as const;

export class PmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PmError";
  }
}

/** True for exactly the managers npms can route to (see ALL_PMS). */
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
    return { pm, via: "flag --pm" };
  }
  const cwd = process.cwd();
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return { pm: "pnpm", via: "pnpm-lock.yaml" };
  if (existsSync(join(cwd, "yarn.lock"))) return { pm: "yarn", via: "yarn.lock" };
  if (existsSync(join(cwd, "package-lock.json"))) return { pm: "npm", via: "package-lock.json" };
  if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb")))
    return { pm: "bun", via: "bun.lock" };
  const fromField = readPackageManagerField(cwd);
  if (fromField) return { pm: fromField, via: "packageManager field" };
  return { pm: "npm", via: "default" };
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
