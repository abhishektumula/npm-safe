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

// encodeURIComponent would turn "@scope/pkg" into "@scope%2Fpkg",
// which the npm registry and Snyk both reject. Encode each path
// segment, preserve "/" and leading "@".
export function encodePkg(name: string): string {
  return name
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/^%40/, "@"))
    .join("/");
}
