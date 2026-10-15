# Contributing

The contributor contract is [AGENTS.md](AGENTS.md): architecture map, engine
rules, tests, docs, commit policy. Read it first. Recipes for adding a
manager, intel source or flag are in [docs/extending.md](docs/extending.md).

## Setup

| Task              | Command                          |
| ----------------- | -------------------------------- |
| Install deps      | `bun install`                    |
| Run CLI (dev)     | `bun ./index.ts …`               |
| Typecheck         | `bun run check`                  |
| Lint / format     | `bun run lint` / `bun run format` (Biome; CI runs `format:check`) |
| Tests             | `bun test` (suites in `test/`)   |
| Coverage          | `bun test --coverage` (gate: ≥90%) |
| Build (node dist) | `bun run build` → `dist/`        |
| Intel smoke test  | `bun ./index.ts add left-pad --dry-run --pm npm` |
| Binary-path smoke | `bun ./index.ts run --dry-run build` |

Develop on Bun; `src/` uses no `Bun.*` APIs, and `bun run build` emits a
`dist/` bundle that also runs on Node ≥18. Tests never touch the network or
your real `~/.npmrc`/cache: stub `globalThis.fetch`, use temp dirs, and set
`HOME`/`NPS_CACHE_DIR` when a test reads them.

Releasing: [docs/packaging.md](docs/packaging.md). Add a line to
[CHANGELOG.md](CHANGELOG.md) for every user-visible change.
