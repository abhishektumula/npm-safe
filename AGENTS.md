# AGENTS.md — npms contributor contract

`npms` (package `npm-safe`) is an npm wrapper: it shows package intel
(dependencies, health) **before** installing, asks `[y/N]`, then installs
through the project’s own package manager.

Read this file before changing anything. It tells you where things live,
what rules are load-bearing, and exactly when to commit.

## 1. Commands (bun-first)

| Task              | Command                          |
| ----------------- | -------------------------------- |
| Install deps      | `bun install`                    |
| Run CLI (dev)     | `bun ./index.ts …`               |
| Typecheck         | `bun run check` (`tsc --noEmit`) |
| Tests             | `bun test`                       |
| Coverage          | `bun test --coverage` (≥90%)     |
| Build (node dist) | `bun run build` → `dist/`        |
| Intel smoke test  | `bun ./index.ts add left-pad --dry-run --pm npm` |
| Binary-path smoke | `bun ./index.ts run --dry-run build` (no network, no spawn) |

- Use `bun <file>`, `bun test`, `bun install`, `bun run <script>`, `bunx <pkg>`.
- Never add `dotenv` (Bun loads `.env`), `execa`, or a test runner other
  than `bun test`.
- TypeScript imports keep the `.ts` extension (`./cli.ts`, never `./cli.js`).

## 2. Architecture map — where to change what

| File               | Owns                                                | Change when …                                      |
| ------------------ | --------------------------------------------------- | -------------------------------------------------- |
| `index.ts`         | Binary entry (`process.argv` → `run()`, `node` shebang) | Entry/runtime support changes |
| `src/cli.ts`       | Arg parsing, `install` vs `passthrough` routing, status output (thin orchestrator) | Flags, commands, UX flow |
| `src/inspect.ts`   | `inspectOne()` + `inspectPackages()` orchestration over npm/snyk/deps | Intel pipeline changes |
| `src/prompt.ts`    | `[y/N]` confirm via `node:readline` + pure `parseConfirmAnswer()` | Prompt UX |
| `src/install.ts`   | **Only file allowed to install/run packages.** Per-PM engines behind `performInstall` / `performPassthrough` | Any install or spawn behavior |
| `src/pm.ts`        | Detecting which manager owns `cwd` (lockfiles → `packageManager` field → npm default) | Detection rules only |
| `src/npm.ts`       | Registry metadata (`registry.npmjs.org/:pkg/latest`) | Intel fields, registry handling |
| `src/snyk.ts`      | Snyk health scrape                                  | Health source/parsing changes                      |
| `src/deps.ts`      | Transitive-dep BFS (`CONCURRENCY`, `MAX_NODES`)     | Counting strategy, limits                          |
| `src/spec.ts`      | Spec parsing (`splitSpec`) + scope-safe encoding (`encodePkg`) | Package-spec syntax |
| `src/render.ts`    | Full card vs compact row, badges                    | Display layout                                     |
| `src/colors.ts`    | Hand-rolled ANSI (color only, no bold/italic)       | Palette/bar changes                                |
| `src/types.ts`     | Shared interfaces (`NpmMeta`, `Health`, `PackageReport`, `CliOptions`) | Cross-module contracts |
| `src/arborist.d.ts`| Minimal ambient types for untyped `@npmcli/arborist` | Engine surface changes |
| `test/`            | `bun test` suites mirroring `src/`                  | Any behavior change needs a test                   |
| `docs/`            | Extending/packaging/releasing guides                | Keep in sync with code changes                     |

Data flow: `run()` → `parseArgs()` → per-package `inspectOne()`
(`fetchNpmMeta` + `fetchHealth` in parallel, then `countTransitive`) →
`render()` → `detectPm()` → confirm → `performInstall()`.

## 3. Engine rules (load-bearing)

- npm installs **in-process** via `@npmcli/arborist`
  (`buildIdealTree({ add })` → `reify()`). Never shell out for npm.
- yarn installs **in-process** via `@yarnpkg/core`
  (`Configuration.find` → activate `plugin-npm` + both linker plugins →
  descriptors into workspace manifest → `persistManifest()` →
  `project.install({ cache, report })`). Activate plugins *before* reading
  config keys — settings like `nodeLinker` are plugin-contributed.
- pnpm / bun / brew have **no programmatic install API** (pnpm ≥12 is a
  native binary; bun is a single CLI-only binary). They go through the one
  argv-only spawn boundary in `src/install.ts` — never build shell strings.
- Passthrough commands (`run`, `test`, `exec`, `remove`, …) are CLI-only
  surface in every manager: spawn via `performPassthrough`, argv only.
- No `Bun.*` APIs in `src/` (`node:readline` for prompts, `process.argv`
  shape) — the CLI must also run under Node ≥18.
- Bare specs (`left-pad`) default to the latest caret range (`^x.y.z`,
  exact on `--save-exact`/`-E`) so typos fail at resolve time, not mid-install.
- Unknown user flags ride in `CliOptions.extraArgs`: binary installers
  forward them; engines map `--save-exact`/`-E` and report the rest ignored.

## 4. Product spec (preserved from the original brief)

Show per package: name + version, description, author, repo URL,
direct / transitive / total dep counts, health score `/100` with bar plus
`security` / `popularity` / `maintenance` / `community` breakdown.
Intel: `registry.npmjs.org` for metadata, `security.snyk.io` (scraped) for health.
Flow: `npms install <pkgs>` → intel cards → `[y/N]` → install with the
detected manager. Multiple packages in one command. 3+ packages (without
`-a`) collapse to compact rows: `total(direct, transitive)`, no repo URL.
Flags: `-a/--all` (dep names, transitive sample, license, health detail),
`-y/--yes`, `-D/--dev`, `--pm`, `--dry-run`, `--json`, `-v`, `-h`.
Keep latency minimal (parallel fetches, bounded BFS), output colorful
(JetBrainsMono / GeistMono Nerd Font friendly), no UI beyond the terminal.

## 5. Conventions

- One module per concern; no AI slop — match existing style, no drive-by refactors.
- For PM integrations, check official docs/APIs first (in-repo history:
  Arborist README, yarn berry API docs), then write code.
- Pure, network-free logic (parsing, rendering, detection) must be unit-testable.
- Network-touching paths get dry-run coverage, never live installs in tests.

## 6. Tests

- `bun test`, suites in `test/` mirroring `src/` (`test/cli.test.ts`, …).
- Coverage gate: **≥90% lines+functions** (`bun test --coverage`).
  If a change drops coverage below the gate, add tests in the same set.
- Never hit the network in tests: stub `globalThis.fetch`, use temp dirs.

## 7. Docs

- `README.md`: description, install, every command (dev/build/test/
  package/release), flags, examples.
- `docs/extending.md`: how to add a package manager, intel source, or flag.
- `docs/packaging.md`: bin (`npms`), build, publish, release checklist.
- Code change without matching doc update = incomplete set.

## 8. Commit policy — when to commit

Commit **after each finished, verified set** — and only then:

1. **One set = one commit.** A set is a single phase from the plan
   (feature, refactor, tests, docs) that is complete on its own.
2. **Verify first, always:** `bun run check`, `bun test` (≥90% coverage),
   plus the relevant smoke test from §1. Never commit red output.
3. **Inspect before staging:** `git status`, `git diff`, `git log --oneline -5`.
   Stage only intended files. Never commit secrets, `.env`, editor dirs,
   or scratch/temp files.
4. **Message format:** short imperative subject (≤72 chars), then bullets
   saying what changed and what was verified. No empty messages.
5. **Never** amend after push, force-push, commit with `--no-verify`, or push
   / open PRs unless explicitly asked. Stop after committing and report;
   wait for the next phase’s go-ahead.
6. Docs-only and code-only changes never share a commit unless the docs
   describe exactly that code change.
