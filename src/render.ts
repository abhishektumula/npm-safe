import { c, paint, healthBar, healthColor } from "./colors.ts";
import type { PackageReport } from "./types.ts";

const rule = paint(c.dim, "─".repeat(52));

function scoreText(score: number | null): string {
  if (score === null) return paint(c.dim, "n/a (snyk unreachable)");
  return paint(healthColor(score), `${score}/100`) + " " + healthBar(score);
}

function badge(text: string): string {
  const t = text.toLowerCase();
  if (/no known|healthy|active|key|influential|popular/.test(t)) return paint(c.green, text);
  if (/sustain|moderate/.test(t)) return paint(c.yellow, text);
  if (/limited|inactive|review needed/.test(t)) return paint(c.orange, text);
  return paint(c.dim, text);
}

// 3+ packages collapse to compact rows (per product spec); -a opts back out.
export const COMPACT_THRESHOLD = 3;

// Full card: below threshold. Compact row: at/above threshold per spec.
export function render(reports: PackageReport[], showAll: boolean): string {
  const compact = reports.length >= COMPACT_THRESHOLD && !showAll;
  const out: string[] = [];
  out.push("");
  out.push(paint(c.pink, "  ◆ npms") + paint(c.dim, "  package intel before you install"));
  out.push(rule);
  for (const r of reports) {
    out.push(compact ? compactRow(r) : fullCard(r, showAll));
    out.push(rule);
  }
  return out.join("\n");
}

function fullCard(r: PackageReport, showAll: boolean): string {
  const L: string[] = [];
  if (r.isNonRegistry) {
    L.push(paint(c.yellow, `  ⚠ ${r.query}`) + paint(c.dim, "  — non-registry spec (intel skipped)"));
    return L.join("\n");
  }
  if (!r.meta) {
    L.push(paint(c.red, `  ✖ ${r.query}`) + paint(c.dim, `  — ${r.metaError ?? "fetch failed"}`));
    return L.join("\n");
  }
  const m = r.meta;
  L.push(`  ${paint(c.cyan, "◆")} ${paint(c.white, m.name)} ${paint(c.dim, "v" + m.version)}`);
  if (m.description) L.push(`  ${paint(c.dim, m.description)}`);
  L.push(`  ${paint(c.violet, "author ")} ${paint(c.white, m.author)}`);
  L.push(`  ${paint(c.violet, "repo   ")} ${paint(c.teal, m.repoUrl)}`);
  L.push(
    `  ${paint(c.violet, "deps   ")} ${paint(c.lime, String(r.directCount))}${paint(c.dim, " direct")}  ` +
      `${paint(c.lime, String(r.transitiveCount))}${paint(c.dim, " transitive")}  ` +
      `${paint(c.white, String(r.totalCount))}${paint(c.dim, " total")}`,
  );
  L.push(`  ${paint(c.violet, "health ")} ${scoreText(r.health.score)}`);
  if (r.health.breakdown) {
    const b = r.health.breakdown;
    L.push(
      `           ${paint(c.dim, "security")} ${badge(b.security)}  ` +
        `${paint(c.dim, "popularity")} ${badge(b.popularity)}`,
    );
    L.push(
      `           ${paint(c.dim, "maintenance")} ${badge(b.maintenance)}  ` +
        `${paint(c.dim, "community")} ${badge(b.community)}`,
    );
  }
  if (showAll) {
    L.push(`  ${paint(c.violet, "license")} ${m.license}`);
    L.push(
      `  ${paint(c.violet, "direct ")} ` +
        (m.directDeps.length ? paint(c.teal, m.directDeps.join(", ")) : paint(c.dim, "none")),
    );
    if (r.transitiveNames.length) {
      const shown = r.transitiveNames.slice(0, 30).join(", ");
      const rest = r.transitiveNames.length > 30 ? ` +${r.transitiveNames.length - 30} more` : "";
      L.push(`  ${paint(c.violet, "trans  ")} ${paint(c.dim, shown + rest)}`);
    }
  }
  L.push(`  ${paint(c.dim, `fetched in ${r.elapsedMs}ms`)}`);
  return L.join("\n");
}

function compactRow(r: PackageReport): string {
  if (r.isNonRegistry) {
    return paint(c.yellow, `  ⚠ ${r.query}`) + paint(c.dim, "  — non-registry spec (intel skipped)");
  }
  if (!r.meta) return paint(c.red, `  ✖ ${r.query}`) + paint(c.dim, ` — ${r.metaError ?? "fetch failed"}`);
  const depBits = `${r.totalCount}(${r.directCount}d, ${r.transitiveCount}t)`;
  const score = r.health.score === null ? paint(c.dim, "n/a") : paint(healthColor(r.health.score), `${r.health.score}/100`);
  return (
    `  ${paint(c.cyan, "◆")} ${paint(c.white, r.meta.name)} ${paint(c.dim, "v" + r.meta.version)}  ` +
    `${paint(c.lime, depBits)}  ${paint(c.dim, "health")} ${score}`
  );
}
