// Single source of truth: package.json. `bun build` inlines the JSON, so the
// published dist/ carries the right version with no runtime file read.
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

/**
 * Names nps itself is installed under: the npm package plus the GitHub
 * Packages mirror (release.yml). `nps scan` leaves these out — screening the
 * scanner is noise, not intel.
 */
export const SELF_NAMES: readonly string[] = [pkg.name, "@abhishektumula/nps"];
