# CLAUDE.md — pointer (Claude Code entry point)

Canonical agent instructions live in **AGENTS.md** — read that file first.
It covers commands, the architecture map (where to change what), engine
rules, product spec, tests/coverage, docs, and the commit policy.

(Claude-specific note: this repo is bun-first — `bun install`, `bun test`,
`bun ./index.ts …`, `bunx` instead of npx. No dotenv, no jest/vitest.)
