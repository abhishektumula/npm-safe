# nps — see package intel before you install

`nps` is an npm wrapper with a safety screen. Instead of blindly running
`npm install <pkg>`, run `nps install <pkg>` and see, **before anything
is written**:

- name + version, description, author, repo URL
- direct / transitive / total dependency counts
- Snyk health score `/100` with `security` / `popularity` /
  `maintenance` / `community` breakdown

…then a `[y/N]` prompt. Confirm and it installs through your project's
own package manager. 3+ packages collapse to compact rows.
(Registry name: `@hort/nps`.)

## Install

From the registry (Node ≥18, no checkout needed):

```bash
npm install -g @hort/nps   # exposes the `nps` command
nps --version
```

Or try it without installing: `npx -y @hort/nps --version`.

From source:

```bash
bun install          # dev dependencies
```

Run without installing globally:

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

Non-registry specs (`user/repo`, `file:`, `link:`, tarballs) have no
registry page to inspect, so intel is skipped with a warning and they
install straight through. `-g`/`--global` is rejected on the npm/yarn
engines (local-project only) — use `--pm pnpm|bun|brew` or install
globally directly.

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

Unknown flags go to binary installers (`pnpm`/`bun`/`brew`); the
npm/yarn engines map `--save-exact`/`-E` and `-D`/`-P`/`-O`, ignoring
the rest. `-P` always means *peer* — pnpm gets `--save-peer`, since
pnpm-native `-P` means `--save-prod`. `-D` can't combine with `-P`/`-O`.

`-w`/`--workspace <name>` targets one workspace package everywhere:
npm filters via Arborist, yarn writes the named manifest, `pnpm`/`bun`
get `--filter <name>`. `--filter` itself is binary-only — rejected on
the npm/yarn engines, use `-w`.

## Package managers

Auto-detected from your directory — lockfiles first
(`pnpm-lock.yaml` → `yarn.lock` → `package-lock.json` → `bun.lock`),
then the `packageManager` field, defaulting to `npm`. Override with `--pm`.

| Manager    | How nps installs                              |
| ---------- | ---------------------------------------------- |
| npm        | In-process via `@npmcli/arborist` (official engine) |
| yarn       | In-process via `@yarnpkg/core` (official API)  |
| pnpm/bun/brew | Their binaries (no programmatic API exists) |

`run`, `test`, `exec`, `remove`, … always pass straight through.

`--dev` is a no-op for `brew`. Health under 40/100, unreachable, or
unparsable prints a warning before the prompt — never blocks.

Private registries: `--registry`, `.npmrc` (`registry`,
`@scope:registry`, `//host/:_authToken` with `${VAR}`), or `NPM_TOKEN` —
for intel and install alike.

## Privacy

Inspecting a package sends its name to the registry (metadata) and
`security.snyk.io` (health). Nothing else leaves your machine — no
telemetry, no accounts. Tokens go only to the registry host and are
never printed.

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

Develop on Bun; `src/` uses no `Bun.*` APIs, and `bun run build` emits
a `dist/` bundle that also runs on Node ≥18.

## Packaging & releasing

Binary shipped: `nps` (see `package.json`). Versioning, publish, and
the release checklist: [`docs/packaging.md`](docs/packaging.md).

## Extending

Adding a manager, intel source, or flag is a short checklist-driven
change — see [`docs/extending.md`](docs/extending.md).

## Docs for contributors

- [`AGENTS.md`](AGENTS.md) — contributor contract (architecture, engine
  rules, commit policy). Read it before changing code.
- [`docs/extending.md`](docs/extending.md) — how to extend.
- [`docs/packaging.md`](docs/packaging.md) — bin, build, publish, releases.
