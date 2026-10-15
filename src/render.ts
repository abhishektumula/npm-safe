import { c, paint, healthBar, healthColor } from "./colors.ts";
import { formatCount } from "./downloads.ts";
import { sanitizeTerminal } from "./sanitize.ts";
import type { PackageReport } from "./types.ts";

// A function, not a constant: paint() consults --no-color/NO_COLOR at call time.
const rule = (): string => paint(c.blue, "─".repeat(52));

function scoreText(score: number | null, unparsed?: boolean, skipped?: boolean): string {
  if (score === null && skipped) return paint(c.white, "n/a (snyk disabled)");
  if (score === null && unparsed) return paint(c.yellow, "n/a (snyk parse failed)");
  // White, not dim: dim grey is unreadable on translucent/blurred terminals.
  // (Applies module-wide: no c.dim is used in render output anymore.)
  if (score === null) return paint(c.white, "n/a (snyk unreachable)");
  return paint(healthColor(score), `${score}/100`) + " " + healthBar(score);
}

/** Advisory summary, or null when OSV was not queried. */
export function advisoryText(r: PackageReport): string | null {
  if (r.vulns === undefined) return null;
  if (r.vulns === null) return paint(c.white, "n/a (osv unreachable)");
  if (r.vulns.count === 0) return paint(c.green, "no known advisories");
  const ids = r.vulns.ids.slice(0, 3).map(sanitizeTerminal).join(", ");
  const more = r.vulns.count > 3 ? ` +${r.vulns.count - 3} more` : "";
  const sev = r.vulns.worst ? ` (worst: ${r.vulns.worst})` : "";
  const color = r.vulns.worst === "low" || r.vulns.worst === "moderate" ? c.yellow : c.red;
  return paint(color, `${r.vulns.count} known${sev}`) + paint(c.white, `  ${ids}${more}`);
}

/** Human warnings for deprecated / install-script / lookalike signals. */
export function signalWarnings(r: PackageReport): string[] {
  const s = r.signals;
  if (!s) return [];
  const out: string[] = [];
  if (s.deprecated) out.push(`deprecated: ${truncateDesc(sanitizeTerminal(s.deprecated))}`);
  if (s.installScripts.length > 0) {
    out.push(`runs code on install: ${s.installScripts.join(", ")} script`);
  }
  if (s.lowDownloads) out.push("rarely used (under 100 downloads/week)");
  if (s.lookalike)
    out.push(`name is close to popular package "${s.lookalike}" — check for a typosquat`);
  return out;
}

function badge(text: string): string {
  const t = text.toLowerCase();
  if (/no known|healthy|active|key|influential|popular/.test(t)) return paint(c.green, text);
  if (/sustain|moderate/.test(t)) return paint(c.yellow, text);
  if (/limited|inactive|review needed/.test(t)) return paint(c.orange, text);
  return paint(c.white, text);
}

// 3+ packages collapse to compact rows (per product spec); -a opts back out.
export const COMPACT_THRESHOLD = 3;

// Long registry descriptions would stretch a card over many lines, so the
// card shows a prefix and an ellipsis. Display-only: --json still carries
// the full text, and short descriptions render byte-identical to before.
export const MAX_DESC_CHARS = 160;

/** Trim to MAX_DESC_CHARS code points (sanitized text has no escapes, so a slice is safe). */
function truncateDesc(text: string): string {
  const chars = [...text];
  if (chars.length <= MAX_DESC_CHARS) return text;
  return `${chars.slice(0, MAX_DESC_CHARS - 1).join("")}…`;
}

// Full card: below threshold. Compact row: at/above threshold per spec.
export function render(reports: PackageReport[], showAll: boolean): string {
  const compact = reports.length >= COMPACT_THRESHOLD && !showAll;
  // Column widths are derived from the input rows only (no TTY reads, so
  // render stays pure and deterministic): padding keeps the deps and health
  // columns aligned when names/versions have different lengths.
  const widths = compact ? compactWidths(reports) : null;
  const out: string[] = [];
  out.push("");
  out.push(paint(c.pink, "  ◆ nps") + paint(c.cyan, "  package intel before you install"));
  out.push(rule());
  for (const r of reports) {
    out.push(compact ? compactRow(r, widths) : fullCard(r, showAll));
    out.push(rule());
  }
  return out.join("\n");
}

interface CompactWidths {
  title: number;
  deps: number;
}

function compactWidths(reports: PackageReport[]): CompactWidths {
  let title = 0;
  let deps = 0;
  for (const r of reports) {
    if (!r.meta) continue;
    const name = sanitizeTerminal(r.meta.name);
    const ver = `v${sanitizeTerminal(r.meta.version)}`;
    title = Math.max(title, [...`${name} ${ver}`].length);
    deps = Math.max(deps, [...`${r.totalCount}(${r.directCount}d, ${r.transitiveCount}t)`].length);
  }
  return { title, deps };
}

function fullCard(r: PackageReport, showAll: boolean): string {
  const L: string[] = [];
  if (r.isNonRegistry) {
    L.push(
      paint(c.yellow, `  ⚠ ${sanitizeTerminal(r.query)}`) +
        paint(c.white, "  — non-registry spec (intel skipped)"),
    );
    return L.join("\n");
  }
  // Every interpolated string below is registry- or scraper-sourced and
  // therefore untrusted: sanitize before painting (paint adds our own
  // codes after, so styling survives while injected sequences do not).
  const t = sanitizeTerminal;
  if (!r.meta) {
    L.push(
      paint(c.red, `  ✖ ${t(r.query)}`) + paint(c.white, `  — ${t(r.metaError ?? "fetch failed")}`),
    );
    return L.join("\n");
  }
  const m = r.meta;
  L.push(
    `  ${paint(c.cyan, "◆")} ${paint(c.white, t(m.name))} ${paint(c.white, "v" + t(m.version))}`,
  );
  if (m.description) L.push(`  ${paint(c.white, truncateDesc(t(m.description)))}`);
  L.push(`  ${paint(c.violet, "author ")} ${paint(c.white, t(m.author))}`);
  L.push(`  ${paint(c.violet, "repo   ")} ${paint(c.teal, t(m.repoUrl))}`);
  L.push(
    `  ${paint(c.violet, "deps   ")} ${paint(c.lime, String(r.directCount))}${paint(c.white, " direct")}  ` +
      `${paint(c.lime, String(r.transitiveCount))}${paint(c.white, " transitive")}  ` +
      `${paint(c.white, String(r.totalCount))}${paint(c.white, " total")}` +
      `${r.truncated ? paint(c.white, "  (partial: crawl hit its budget)") : ""}`,
  );
  L.push(
    `  ${paint(c.violet, "health ")} ${scoreText(r.health.score, r.health.unparsed, r.health.skipped)}`,
  );
  if (r.health.breakdown) {
    const b = r.health.breakdown;
    L.push(
      `           ${paint(c.white, "security")} ${badge(t(b.security))}  ` +
        `${paint(c.white, "popularity")} ${badge(t(b.popularity))}`,
    );
    L.push(
      `           ${paint(c.white, "maintenance")} ${badge(t(b.maintenance))}  ` +
        `${paint(c.white, "community")} ${badge(t(b.community))}`,
    );
  }
  if (typeof r.downloads === "number") {
    L.push(
      `  ${paint(c.violet, "usage  ")} ${paint(c.white, `${formatCount(r.downloads)} downloads/week`)}`,
    );
  }
  const adv = advisoryText(r);
  if (adv) L.push(`  ${paint(c.violet, "vulns  ")} ${adv}`);
  for (const w of signalWarnings(r)) L.push(`  ${paint(c.orange, "⚠")} ${paint(c.orange, w)}`);
  if (showAll) {
    L.push(`  ${paint(c.violet, "license")} ${t(m.license)}`);
    L.push(
      `  ${paint(c.violet, "direct ")} ` +
        (m.directDeps.length
          ? paint(c.teal, m.directDeps.map(t).join(", "))
          : paint(c.white, "none")),
    );
    if (r.transitiveNames.length) {
      const shown = r.transitiveNames.map(t).slice(0, 30).join(", ");
      const rest = r.transitiveNames.length > 30 ? ` +${r.transitiveNames.length - 30} more` : "";
      L.push(`  ${paint(c.violet, "trans  ")} ${paint(c.teal, shown + rest)}`);
    }
  }
  L.push(
    `  ${paint(c.teal, `fetched in ${r.elapsedMs}ms`)}` +
      (r.stale ? paint(c.yellow, "  (offline: showing cached data)") : ""),
  );
  return L.join("\n");
}

function compactFlags(r: PackageReport): string {
  const bits: string[] = [];
  if (r.vulns && r.vulns.count > 0) bits.push(paint(c.red, `${r.vulns.count} vuln`));
  if (r.signals?.deprecated) bits.push(paint(c.orange, "deprecated"));
  if (r.signals && r.signals.installScripts.length > 0)
    bits.push(paint(c.orange, "install-script"));
  if (r.signals?.lookalike) bits.push(paint(c.orange, `~${r.signals.lookalike}?`));
  return bits.length ? `  ${bits.join(" ")}` : "";
}

function compactRow(r: PackageReport, widths: CompactWidths | null = null): string {
  if (r.isNonRegistry) {
    return (
      paint(c.yellow, `  ⚠ ${sanitizeTerminal(r.query)}`) +
      paint(c.white, "  — non-registry spec (intel skipped)")
    );
  }
  if (!r.meta)
    return (
      paint(c.red, `  ✖ ${sanitizeTerminal(r.query)}`) +
      paint(c.white, ` — ${sanitizeTerminal(r.metaError ?? "fetch failed")}`)
    );
  const depBits = `${r.totalCount}(${r.directCount}d, ${r.transitiveCount}t)`;
  const score =
    r.health.score === null
      ? r.health.unparsed
        ? paint(c.yellow, "n/a (parse failed)")
        : paint(c.white, "n/a")
      : paint(healthColor(r.health.score), `${r.health.score}/100`);
  // Padding goes inside the dim version segment (plain spaces, no new
  // glyphs), so short names don't shift the deps/health columns.
  const name = sanitizeTerminal(r.meta.name);
  const ver = `v${sanitizeTerminal(r.meta.version)}`;
  const gap = widths ? Math.max(0, widths.title - [...`${name} ${ver}`].length) : 0;
  const depsPad = widths ? " ".repeat(Math.max(0, widths.deps - [...depBits].length)) : "";
  return (
    `  ${paint(c.cyan, "•")} ${paint(c.white, name)} ${paint(c.white, `${ver}${" ".repeat(gap)}`)}  ` +
    `${paint(c.lime, `${depBits}${depsPad}`)}  ${paint(c.white, "health")} ${score}` +
    compactFlags(r)
  );
}
