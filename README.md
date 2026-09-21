# npms — see package intel before you install

`npms` is an npm wrapper with a safety screen. Instead of blindly running
`npm install <pkg>`, you run `npms install <pkg>` and get, **before anything
is written**:

- name + version, description, author, repo URL
- direct / transitive / total dependency counts
- a Snyk health score `/100` (with `security` / `popularity` /
  `maintenance` / `community` breakdown)

…then a `[y/N]` prompt. Confirm, and it installs through your project's own
package manager. Three or more packages collapse to compact rows so the
screen stays scannable. (Package name on the registry: `npm-safe`.
`npm-safe` remains as a CLI alias.)

## Install

```bash
bun install          # dependencies for development
```

Run it without installing globally:

```bash
bun ./index.ts install express
```

Or link it as a global command:

```bash
bun link             # exposes `npms` (and `npm-safe`) on your PATH
```

## Usage

```bash
npms install express lodash -a     # intel cards, full detail, then confirm
npms i "express@5" --dry-run       # inspect only, install nothing
npms express lodash -y             # bare packages also mean install
npms run dev / test / exec …       # passthrough to your package manager
npms uninstall foo                 # passthrough, no intel screen
npms add left-pad --json           # machine-readable report
```

| Flag          | Effect                                                        |
| ------------- | ------------------------------------------------------------- |
| `-a, --all`   | Full detail: dep names, transitive sample, license, breakdown |
| `-y, --yes`   | Skip the `[y/N]` prompt                                       |
| `-D, --dev`   | Install as devDependency                                      |
| `--pm <name>` | Force manager: `npm` \| `bun` \| `pnpm` \| `yarn` \| `brew`   |
| `--dry-run`   | Show intel only, never install                                |
| `--json`      | Machine-readable report instead of the color card             |
| `-v, --version` | Print version                                               |
| `-h, --help`  | Help                                                          |

Unknown flags are forwarded to binary installers (`pnpm`/`bun`/`brew`);
the npm/yarn engines map `--save-exact`/`-E` and report the rest ignored.

## Package managers

The manager is auto-detected from your directory — lockfiles first
(`pnpm-lock.yaml` → `yarn.lock` → `package-lock.json` → `bun.lock`),
then the `packageManager` field, defaulting to `npm`. Override any time
with `--pm`.

| Manager    | How npms installs                              |
| ---------- | ---------------------------------------------- |
| npm        | In-process via `@npmcli/arborist` (official engine) |
| yarn       | In-process via `@yarnpkg/core` (official API)  |
| pnpm/bun/brew | Their binaries (no programmatic API exists) |

`run`, `test`, `exec`, `remove`, … are CLI-only surface in every manager,
so they always pass straight through.

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

Binaries shipped: `npms` (primary) + `npm-safe` (alias), both declared in
`package.json`. Full procedure — versioning, publish, release checklist —
lives in [`docs/packaging.md`](docs/packaging.md).

## Extending

Adding a package manager, an intel source, or a flag is a short,
checklist-driven change — see [`docs/extending.md`](docs/extending.md).

## Docs for contributors

- [`AGENTS.md`](AGENTS.md) — contributor contract: architecture map (where
  to change what), engine rules, commit policy. Read it before changing code.
- [`docs/extending.md`](docs/extending.md) — how to extend the package.
- [`docs/packaging.md`](docs/packaging.md) — bin, build, publish, releases.
