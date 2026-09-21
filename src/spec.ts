// Package spec parsing + registry-safe encoding.
// Works identically under Node, Bun, Deno — no runtime APIs here.
//
//   "express"            -> { name: "express", version: null }
//   "express@5"          -> { name: "express", version: "5" }
//   "@scope/pkg"         -> { name: "@scope/pkg", version: null }
//   "@scope/pkg@1.2.3"   -> { name: "@scope/pkg", version: "1.2.3" }

export interface PkgSpec {
  name: string;
  version: string | null;
}

export function splitSpec(query: string): PkgSpec {
  const q = query.trim();
  if (!q) return { name: q, version: null };
  // Scoped: leading @ — version separator is the *second* @.
  if (q.startsWith("@")) {
    const slash = q.indexOf("/");
    const at = q.indexOf("@", 1);
    // "@scope/pkg@ver" — the @ must come after the slash.
    if (at > slash && slash !== -1) {
      return { name: q.slice(0, at), version: q.slice(at + 1) || null };
    }
    return { name: q, version: null };
  }
  const at = q.indexOf("@");
  if (at === -1) return { name: q, version: null };
  return { name: q.slice(0, at), version: q.slice(at + 1) || null };
}

// Structural allowlist for registry package names (mirrors the rules
// enforced by validate-npm-package-name for new packages, without the
// dependency): length, scope shape, leading ./_, charset. Anything with a
// protocol (`file:`, `git+ssh:`, `http:`), a path (`/etc/`, `..\`), or a
// version separator smuggled into the name fails here — before any fetch
// and before any engine — so non-registry specs get a clear error instead
// of an incidental lookup failure. The registry remains the source of
// truth for whether a well-formed name exists.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_NAME_LENGTH = 214;

export function isValidPkgName(name: string): boolean {
  if (!name || name.length > MAX_NAME_LENGTH) return false;
  if (name.includes(":") || name.includes("\\") || name.includes(" ")) return false;
  const segs = name.split("/");
  if (name.startsWith("@")) {
    if (segs.length !== 2) return false;
    const [scope, pkg] = segs as [string, string];
    if (!scope || !pkg || !scope.startsWith("@") || scope.length < 2) return false;
    return SEGMENT.test(scope.slice(1)) && SEGMENT.test(pkg);
  }
  if (segs.length !== 1) return false;
  const seg = segs[0]!;
  if (seg === "." || seg === "..") return false;
  return SEGMENT.test(seg);
}

// encodeURIComponent would turn "@scope/pkg" into "@scope%2Fpkg",
// which the npm registry and Snyk both reject. Encode each path
// segment, preserve "/" and leading "@".
export function encodePkg(name: string): string {
  return name
    .split("/")
    .map((seg) => {
      if (seg === ".." || seg === ".") return encodeURIComponent(seg).replace(/\./g, "%2E");
      return encodeURIComponent(seg).replace(/^%40/, "@");
    })
    .join("/");
}
