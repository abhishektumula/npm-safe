import { c, paint, healthBar, healthColor } from "./colors.ts";
import { sanitizeTerminal } from "./sanitize.ts";
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
  // Every interpolated string below is registry- or scraper-sourced and
  // therefore untrusted: sanitize before painting (paint adds our own
  // codes after, so styling survives while injected sequences do not).
  const t = sanitizeTerminal;
  if (!r.meta) {
    L.push(paint(c.red, `  ✖ ${t(r.query)}`) + paint(c.dim, `  — ${t(r.metaError ?? "fetch failed")}`));
    return L.join("\n");
  }
  const m = r.meta;
  L.push(`  ${paint(c.cyan, "◆")} ${paint(c.white, t(m.name))} ${paint(c.dim, "v" + t(m.version))}`);
  if (m.description) L.push(`  ${paint(c.dim, t(m.description))}`);
  L.push(`  ${paint(c.violet, "author ")} ${paint(c.white, t(m.author))}`);
  L.push(`  ${paint(c.violet, "repo   ")} ${paint(c.teal, t(m.repoUrl))}`);
  L.push(
    `  ${paint(c.violet, "deps   ")} ${paint(c.lime, String(r.directCount))}${paint(c.dim, " direct")}  ` +
      `${paint(c.lime, String(r.transitiveCount))}${paint(c.dim, " transitive")}  ` +
      `${paint(c.white, String(r.totalCount))}${paint(c.dim, " total")}` +
      `${r.truncated ? paint(c.dim, "  (partial: crawl hit its budget)") : ""}`,
  );
  L.push(`  ${paint(c.violet, "health ")} ${scoreText(r.health.score)}`);
  if (r.health.breakdown) {
    const b = r.health.breakdown;
    L.push(
      `           ${paint(c.dim, "security")} ${badge(t(b.security))}  ` +
        `${paint(c.dim, "popularity")} ${badge(t(b.popularity))}`,
    );
    L.push(
      `           ${paint(c.dim, "maintenance")} ${badge(t(b.maintenance))}  ` +
        `${paint(c.dim, "community")} ${badge(t(b.community))}`,
    );
  }
  if (showAll) {
    L.push(`  ${paint(c.violet, "license")} ${t(m.license)}`);
    L.push(
      `  ${paint(c.violet, "direct ")} ` +
        (m.directDeps.length
          ? paint(c.teal, m.directDeps.map(t).join(", "))
          : paint(c.dim, "none")),
    );
    if (r.transitiveNames.length) {
      const shown = r.transitiveNames.map(t).slice(0, 30).join(", ");
      const rest = r.transitiveNames.length > 30 ? ` +${r.transitiveNames.length - 30} more` : "";
      L.push(`  ${paint(c.violet, "trans  ")} ${paint(c.dim, shown + rest)}`);
    }
  }
  L.push(`  ${paint(c.dim, `fetched in ${r.elapsedMs}ms`)}`);
  return L.join("\n");
}

function compactRow(r: PackageReport): string {
  if (!r.meta)
    return (
      paint(c.red, `  ✖ ${sanitizeTerminal(r.query)}`) +
      paint(c.dim, ` — ${sanitizeTerminal(r.metaError ?? "fetch failed")}`)
    );
  const depBits = `${r.totalCount}(${r.directCount}d, ${r.transitiveCount}t)`;
  const score = r.health.score === null ? paint(c.dim, "n/a") : paint(healthColor(r.health.score), `${r.health.score}/100`);
  return (
    `  ${paint(c.cyan, "◆")} ${paint(c.white, sanitizeTerminal(r.meta.name))} ${paint(c.dim, "v" + sanitizeTerminal(r.meta.version))}  ` +
    `${paint(c.lime, depBits)}  ${paint(c.dim, "health")} ${score}`
  );
}
