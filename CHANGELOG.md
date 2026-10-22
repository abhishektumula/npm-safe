# Changelog

All notable changes to `nps`. Format: [Keep a Changelog](https://keepachangelog.com/);
versions follow semver (minor bumps may change CLI output while < 1.0).

## [Unreleased]

### Added
- deps.dev intel (free, no key): cards gain a `trust` line with the OpenSSF
  Scorecard, GitHub stars, verified build provenance and publish age for
  the inspected version; `--json` gains `project` (incl. `repoVerified`,
  which catches packages borrowing a popular repo's stars). `nps doctor`
  checks api.deps.dev. Public npm only; fail-open like every source.
- nps health estimate: when Snyk is unreachable, unparsable or disabled,
  the score comes from OSV advisories, weekly downloads, OpenSSF Scorecard
  and publish recency instead of `n/a`, labelled `(nps estimate: …)` on
  cards, `est` in compact rows and `health.source: "estimate"` in `--json`.
  `--min-score` gates on it, so a Snyk outage no longer blocks every
  install. Critical/high advisories and deprecation cap the estimate.
- Signals: "fresh release" (version published under 48h ago — the usual
  window before a hijacked release is pulled) and "no source repository
  linked". Publish time comes from deps.dev, else the registry packument
  (`publishedAt` in `--json`), so brand-new and private versions are covered.
- Policy `minReleaseAgeHours`: block versions younger than N hours
  (violation rule `release-age`; unknown publish time passes).

### Fixed
- Health badges: "Inactive" was painted green (it contains "active").
- `nps check chalk@4` (any version, range or dist-tag) now inspects the
  version that will be installed (`4.1.2`), not `latest`: the card, OSV
  advisories, signals and dep crawl all follow the requested spec. Ranges
  resolve against the abbreviated packument with `semver` (new direct
  dependency, already in the tree via Arborist).
- Intel fetches retry once on a dropped connection, timeout, or 502/504
  gateway error (previously only 429/503), so one slow CDN edge no longer
  blanks a card or the health score.

## [2.1.0] - 2026-10-20

Supply-chain hardening after Socket.dev flagged the published package.

### Changed
- `dist/` no longer bundles dependencies (5 MB -> ~110 KB): third-party code
  (`eval`, `new Function`, `child_process`, env/network access in
  arborist/yarn) was being attributed to `@hort/nps` itself. Dependencies
  now install normally as declared `dependencies`.
- yarn installs now run the `yarn` binary (like pnpm/bun) instead of the
  in-process `@yarnpkg/core` engine. That package pins `got` with a
  yarn-only `patch:` spec, which made **2.0.0 uninstallable with npm**
  (`EUNSUPPORTEDPROTOCOL`). All `@yarnpkg/*` dependencies are gone, which
  also clears the `braces` audit advisory. `--registry` reaches yarn via
  `YARN_NPM_REGISTRY_SERVER`; `-w` maps to `yarn workspace <name> add`;
  `--save-exact` maps to `--exact`.
- Minimum Node is now 20.17 (Node 18 is EOL); `@npmcli/arborist` ^9.9.3 pulls
  patched `pacote` and `sigstore`, clearing their audit advisories.

### Fixed
- Local `npm publish` no longer fails with `Automatic provenance generation
  not supported for provider: null`: `provenance` removed from
  `publishConfig` (CI `release.yml` still publishes with `--provenance`).

## [2.0.0] - 2026-10-16

Major release: `--json` output shape and an exit code changed (see Changed).

### Added
- `nps check <pkg…>`: inspect only, never installs (same as `--dry-run`).
- `nps scan [--prod]`: screen a project's declared dependencies (health,
  advisories, signals) using the version on disk when present.
- `nps doctor`: manager detection, config, cache, registry, Snyk and OSV
  reachability in one command.
- `nps cache-clear`, `nps completions <bash|zsh|fish>`, `nps alias`.
- OSV.dev advisories as a second, structured intel source (no scraping).
- Weekly downloads (public registry) with a "rarely used" signal and a `minWeeklyDownloads` policy rule; `--no-snyk` / `sources.snyk: false` skips the Snyk scrape.
- `nps scan` includes workspace members.
- Local signals: deprecated, install scripts (`preinstall`/`install`/
  `postinstall`, node-gyp), and names close to popular packages.
- Policy gate: `--min-score N` and `nps.config.json` `policy`
  (`minScore`, `blockDeprecated`, `blockVulnerabilities`,
  `allowedLicenses`). Violations exit 3 and `-y` cannot bypass them.
- `--verbose` (stderr diagnostics), `--no-cache`, `--no-color`; `NO_COLOR`
  is honored and piped output is plain.
- Stable exit codes: 0 ok, 1 error, 3 blocked by policy, 4 intel unavailable.
- Offline fallback: expired cache entries (≤7 days) answer when the network
  is down and are labelled stale.
- `-E/--save-exact` documented in help and README.
- CI: Node 18/20/22 × Linux/macOS bundle smoke, weekly live-intel
  canary, tag-driven release with npm provenance, Dependabot.
- `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/json-schema.md`.

### Changed
- `--json` now prints one versioned document
  (`{ schemaVersion, nps, command, policy, packages }`) instead of a bare
  array, never prompts, and sends human lines to stderr. **Breaking** for
  scripts that parsed the old array.
- "Every lookup failed" now exits 4 (was 1).
- Version is read from `package.json` (no duplicated constant).
- `@types/bun` and the CI bun version are pinned.

### Fixed
- `test/npm.test.ts` no longer depends on the developer's `~/.npmrc`.
