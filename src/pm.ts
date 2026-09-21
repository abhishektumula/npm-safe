import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Pm = "bun" | "pnpm" | "npm" | "yarn";

const INSTALL_ARGS: Record<Pm, { normal: string[]; dev: string[] }> = {
  bun: { normal: ["add"], dev: ["add", "--dev"] },
  pnpm: { normal: ["add"], dev: ["add", "--save-dev"] },
  npm: { normal: ["install"], dev: ["install", "--save-dev"] },
  yarn: { normal: ["add"], dev: ["add", "--dev"] },
};

// Local-only, read-only detection — never touches globals.
// Mirrors: [ -f pnpm-lock.yaml ] / yarn.lock / package-lock.json / bun.lock
// First match wins, in that order. Falls back to the packageManager field,
// then npm. Brew is never auto-selected (not a JS installer); --pm brew
// is opt-in.
export function detectPm(override: string | null): { pm: string; via: string } {
  if (override) return { pm: override.toLowerCase(), via: "flag --pm" };
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

function readPackageManagerField(cwd: string): string | null {
  try {
    const raw = readFileSync(join(cwd, "package.json"), "utf8");
    const field = (JSON.parse(raw) as { packageManager?: unknown }).packageManager;
    if (typeof field !== "string") return null;
    const name = field.split("@")[0]!.toLowerCase();
    return ["bun", "pnpm", "npm", "yarn"].includes(name) ? name : null;
  } catch {
    return null;
  }
}

export function installArgs(pm: string, dev: boolean): string[] | null {
  if (pm === "brew") return ["install"]; // system packages only
  const entry = (INSTALL_ARGS as Record<string, { normal: string[]; dev: string[] }>)[pm];
  return entry ? (dev ? entry.dev : entry.normal) : null;
}
