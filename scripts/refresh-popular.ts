// Regenerates src/popular.ts from the registry search API.
//   bun scripts/refresh-popular.ts
// Not part of the build or tests (needs network). Review the diff before committing.
import { writeFileSync } from "node:fs";

const KEYWORDS =
  "framework react vue angular cli build test lint util utility http server database orm logger date string array promise async stream parser markdown css typescript babel webpack bundler crypto auth jwt validation schema types polyfill fs path glob color terminal prompt event cache queue websocket graphql redis sql image compression yaml json xml csv uuid random hash template router middleware express jest eslint".split(
    " ",
  );
const TOP = 600;

const weekly = new Map<string, number>();
for (const k of KEYWORDS) {
  for (const from of [0, 250]) {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`keywords:${k}`)}&size=250&from=${from}&popularity=1&quality=0&maintenance=0`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const body = (await res.json()) as {
      objects: { package: { name: string }; downloads: { weekly: number } }[];
    };
    for (const o of body.objects) {
      weekly.set(o.package.name, Math.max(weekly.get(o.package.name) ?? 0, o.downloads.weekly));
    }
  }
}
const names = [...weekly.entries()]
  .filter(([n]) => !n.startsWith("@"))
  .sort((a, b) => b[1] - a[1])
  .slice(0, TOP)
  .map(([n]) => n);
const body = names.map((n) => JSON.stringify(n)).join(", ");
writeFileSync(
  new URL("../src/popular.ts", import.meta.url),
  `// Most-downloaded unscoped npm packages, used for typosquat lookalike checks.\n// Generated ${new Date().toISOString().slice(0, 10)} by scripts/refresh-popular.ts.\nexport const POPULAR: readonly string[] = [${body}];\n`,
);
console.log(`wrote ${names.length} names`);
