# Packaging, publishing, releasing

## Bin layout

`package.json` ships one binary, `nps`, pointing at the built bundle:

```json
"bin": { "nps": "./dist/index.js" }
```

The registry package is named `@hort/nps`; the command is always `nps`.
Bins point at `dist/`, never at `./index.ts`: TypeScript source runs
under Bun from a checkout, but an installed package must run under plain
Node, so it needs the built JS. `files: ["dist", "README.md", "CHANGELOG.md"]` keeps the
tarball small (`npm pack --dry-run` to confirm).

## Build

```bash
bun run build        # bun build ./index.ts --outdir ./dist --target node
```

- Develop on Bun (`bun ./index.ts …`); `src/` contains no `Bun.*` APIs.
- `dist/` is gitignored build output that runs on Node ≥18 as well as Bun.
- Verify both runtimes after touching the entry or engines:

```bash
bun ./index.ts --help && node ./dist/index.js --help
bun ./index.ts run --dry-run build   # no network, no spawn
```

## Versioning

- Semver. Bump `version` in `package.json` with the change it describes:
  patch for fixes, minor for flags/managers/sources, major for breaking
  CLI or alias changes.
- `package.json` is the only place a version lives: `src/version.ts` imports
  it and `bun build` inlines it. Move the `[Unreleased]` entries in
  `CHANGELOG.md` under the new version heading.

## Publish

```bash
bun run check && bun run test    # gate: green, coverage ≥90%
npm pack --dry-run               # dist/index.js, README.md, CHANGELOG.md, package.json
npm publish --access public      # @hort/nps (runs prepublishOnly → build)
```

`bun.lock` is committed, so installs are reproducible for contributors;
the published tarball needs no lockfile. Engine deps
(`@npmcli/arborist`, `@yarnpkg/*`) install automatically as
`dependencies`.

## Continuous integration

- `.github/workflows/ci.yml` — every push/PR: `bun run check`,
  `bun test --coverage`, `bun audit`, build; then the built bundle is smoke
  tested on Node 18/20/22 × Linux/macOS. Bun is pinned (bump it
  deliberately).
- `.github/workflows/smoke.yml` — weekly live canary against the real
  registry, Snyk and OSV; fails when the Snyk parser stops matching.
- `.github/workflows/release.yml` — pushing a `vX.Y.Z` tag verifies the tag
  matches `package.json`, runs the gates, publishes with npm provenance
  (needs the `NPM_TOKEN` repo secret) and creates the GitHub release from
  `CHANGELOG.md`.
- `.github/dependabot.yml` — weekly npm + Actions updates.

A green CI means the set is safe to commit and release.

## Local install (development only)

`bun link` exposes the bins from your checkout — but they point at
`dist/`, so **rebuild after every change** (`bun run build`), or the
linked commands run stale code. A global command resolving to a path
outside your checkout (`Module not found …/index.ts`) means a stale link
from another clone: unlink it and re-link from the right directory.

## Release checklist

1. `bun run check` green.
2. `bun run test` green with coverage ≥90% (raise it, don't lower it).
3. Smoke tests pass:
   - `bun ./index.ts add left-pad --dry-run --pm npm` (intel + engine plan)
   - `bun ./index.ts run --dry-run build` (passthrough, no spawn)
   - `node ./dist/index.js --help` (node-compatible bundle)
4. `README.md` flags/commands match `--help` output.
5. `docs/` matches the code paths it describes.
6. Version bumped in `package.json`; `CHANGELOG.md` updated.
7. One commit per set (see AGENTS.md §8); tag the release
   (`git tag vX.Y.Z`) **only when explicitly asked** — never push or
   open PRs unasked.
8. Push the tag (`release.yml` publishes), or publish by hand with
   `npm publish --provenance --access public`; then sanity-install in a
   scratch dir: `npm install -g @hort/nps && nps --version`.
