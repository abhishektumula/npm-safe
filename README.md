# nps — see package intel before you install

`nps` is an npm wrapper with a safety screen. Instead of blindly running
`npm install <pkg>`, you run `nps install <pkg>` and get, **before anything
is written**:

- name + version, description, author, repo URL
- direct / transitive / total dependency counts
- a Snyk health score `/100` (with `security` / `popularity` /
  `maintenance` / `community` breakdown)

…then a `[y/N]` prompt. Confirm, and it installs through your project's own
package manager. Three or more packages collapse to compact rows so the
screen stays scannable. (Registry package name: `npm-safe`.)

## Install

From the registry (any machine with Node ≥18, no git checkout needed):

```bash
npm install -g @hort/nps   # exposes the `nps` command
nps --version
```

Or try it without installing: `npx -y @hort/nps --version`.

From source (development):

```bash
bun install          # dependencies for development
```

Run it without installing globally:

```bash
bun ./index.ts install express
```

Or link it as a global command:

```bash
bun link             # exposes `nps` on your PATH
```

## Usage

```bash
nps install express lodash -a     # intel cards, full detail, then confirm
nps install                       # no packages: install project deps
nps i "express@5" --dry-run       # inspect only, install nothing
nps express lodash -y             # bare packages also mean install
nps add user/repo file:../lib    # non-registry specs skip intel + warn
nps add left-pad -w api           # same workspace target on every manager
nps run dev / test / exec …       # passthrough to your package manager
nps uninstall foo                 # passthrough, no intel screen
nps add left-pad --json           # machine-readable report
```

Non-registry specs (`user/repo`, `file:`, `link:`, tarball URLs) have no
registry page to inspect, so nps skips the intel screen for them with a
warning and installs straight through. `-g`/`--global` is rejected for the
npm/yarn in-process engines (they are local-project only) — use
`--pm pnpm|bun|brew` or run the global install directly.

| Flag          | Effect                                                        |
| ------------- | ------------------------------------------------------------- |
| `-a, --all`   | Full detail: dep names, transitive sample, license, breakdown |
| `-y, --yes`   | Skip the `[y/N]` prompt                                       |
| `-D, --dev`   | Install as devDependency                                      |
| `-P, --peer`  | Install as peerDependency (`-P` means peer here)              |
| `-O, --optional` | Install as optionalDependency (both = optional peer)       |
| `-w, --workspace <name>` | Add to a workspace package (same target everywhere) |
| `--registry <url>` | Use a private registry (`.npmrc` + `NPM_TOKEN` also work) |
| `--pm <name>` | Force manager: `npm` \| `bun` \| `pnpm` \| `yarn` \| `brew`   |
| `--dry-run`   | Show intel only, never install                                |
| `--json`      | Machine-readable report instead of the color card             |
| `-v, --version` | Print version                                               |
| `-h, --help`  | Help                                                          |

Unknown flags are forwarded to binary installers (`pnpm`/`bun`/`brew`);
the npm/yarn engines map `--save-exact`/`-E` plus the `-D`/`-P`/`-O` save
flags and report the rest ignored. Note: nps `-P` always means *peer* —
pnpm-native `-P` means `--save-prod`, so nps re-emits `--save-peer` for
pnpm. `-D` can't be combined with `-P`/`-O` on any manager.

`-w`/`--workspace <name>` targets one workspace package on every manager:
the npm engine filters via Arborist, the yarn engine writes the named
manifest, and `pnpm`/`bun` get `--filter <name>`. `--filter` itself stays
binary-only and is rejected on the npm/yarn engines (use `-w`).

## Package managers

The manager is auto-detected from your directory — lockfiles first
(`pnpm-lock.yaml` → `yarn.lock` → `package-lock.json` → `bun.lock`),
then the `packageManager` field, defaulting to `npm`. Override any time
with `--pm`.

| Manager    | How nps installs                              |
| ---------- | ---------------------------------------------- |
| npm        | In-process via `@npmcli/arborist` (official engine) |
| yarn       | In-process via `@yarnpkg/core` (official API)  |
| pnpm/bun/brew | Their binaries (no programmatic API exists) |

`run`, `test`, `exec`, `remove`, … are CLI-only surface in every manager,
so they always pass straight through.

`--dev` is a no-op for `brew` (`brew install` has no dev concept). A low
(<40), unreachable, or unparsable Snyk health score prints a warning
before the prompt; it never blocks the install.

Private registries work via `--registry`, `.npmrc` (`registry`,
`@scope:registry`, `//host/:_authToken` with `${VAR}` interpolation), or
the `NPM_TOKEN` env var — for both the intel screen and the install.

## Privacy

Inspecting a package sends its name to the configured registry
(metadata) and `security.snyk.io` (health score). Nothing else leaves
your machine — no telemetry, no accounts. Registry tokens are sent only
to the registry host, and never printed (status lines redact them).

## Development

| Task              | Command                          |
| ----------------- | -------------------------------- |
| Install deps      | `bun install`                    |
| Run CLI (dev)     | `bun ./index.ts …`               |
| Typecheck         | `bun run check`                  |
| Tests             | `bun test` (suites in `test/`)   |
| Coverage          | `bun test --coverage` (gate: ≥90%) |
| Build (node dist) | `bun run build` → `dist/`        |
| Intel smoke test  | `bun ./index.ts add left-pad --dry-run --pm npm` |
| Binary-path smoke | `bun ./index.ts run --dry-run build` |

Develop on Bun; `src/` uses no `Bun.*` APIs, and `bun run build` produces
a `dist/` bundle that also runs on Node ≥18.

## Packaging & releasing

Binary shipped: `nps`, declared in `package.json`. Full procedure —
versioning, publish, release checklist — lives in
[`docs/packaging.md`](docs/packaging.md).

## Extending

Adding a package manager, an intel source, or a flag is a short,
checklist-driven change — see [`docs/extending.md`](docs/extending.md).

## Docs for contributors

- [`AGENTS.md`](AGENTS.md) — contributor contract: architecture map (where
  to change what), engine rules, commit policy. Read it before changing code.
- [`docs/extending.md`](docs/extending.md) — how to extend the package.
- [`docs/packaging.md`](docs/packaging.md) — bin, build, publish, releases.
