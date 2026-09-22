# Packaging, publishing, releasing

## Bin layout

`package.json` ships one binary, `nps`, pointing at the built bundle:

```json
"bin": { "nps": "./dist/index.js" }
```

The registry package is named `npm-safe`; the command is always `nps`.
Bins point at `dist/`, never at `./index.ts`: TypeScript source runs
under Bun from a checkout, but an installed package must run under plain
Node, so it needs the built JS. `files: ["dist", "README.md"]` keeps the
tarball to three files (`npm pack --dry-run` to confirm).

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
- Keep the `VERSION` constant in `src/cli.ts` in sync with `package.json`.

## Publish

```bash
bun run check && bun run test    # gate: green, coverage ≥90%
npm pack --dry-run               # expect 3 files: dist/index.js, README.md, package.json
npm publish --access public      # package name: npm-safe (runs prepublishOnly → build)
```

`bun.lock` is committed, so installs are reproducible for contributors;
the published tarball needs no lockfile. Engine deps
(`@npmcli/arborist`, `@yarnpkg/*`) install automatically as
`dependencies`.

## Continuous integration

`.github/workflows/ci.yml` runs the contributor gates on every push
and pull request: `bun run check`, `bun test --coverage`, and
`bun audit`. Keep it green — it enforces exactly the gates in
[AGENTS.md](../AGENTS.md) §6, so a green CI means the set is safe to
commit and release.

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
6. Version bumped in `package.json` **and** `src/cli.ts` `VERSION`.
7. One commit per set (see AGENTS.md §8); tag the release
   (`git tag vX.Y.Z`) **only when explicitly asked** — never push or
   open PRs unasked.
8. `npm publish --access public`, then sanity-install in a scratch dir:
    `npm install -g @hort/nps && nps --version`.
