// Single source of truth: package.json. `bun build` inlines the JSON, so the
// published dist/ carries the right version with no runtime file read.
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
