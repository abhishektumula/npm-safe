# Changelog

All notable changes to `nps`. Format: [Keep a Changelog](https://keepachangelog.com/);
versions follow semver (minor bumps may change CLI output while < 1.0).

## [Unreleased]

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
