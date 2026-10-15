# agent-todo.md — planned work (not started, do not implement until told)

## From todo.md (reviewed, scoped)

- [ ] Clarify "change install command on npm registry": README instruction
      (`npm install -g @hort/nps` → e.g. npx-first, pnpm/bun variants) vs package
      rename (scoped `@hort/nps` → unscoped). Registry command follows the package
      name — no code change possible without a rename. Decision needed first.
- [x] (verified: npm, yarn, pnpm, bun map -D; brew no-op) Verify "add as dev dependency" (`-D/--dev`) on each manager; close if
      green (flag exists, engines map it, brew is a documented no-op). If a gap
      repros, file it as a bug fix with the repro.
- [x] (done) Add `--no-cache` CLI flag (cache currently only disabled via
      `NPS_NO_CACHE=1`). Include help text, README flag row, docs, tests.
- [x] (done as `nps cache-clear`) Add cache clearing (`nps cache clean` or equivalent). Include docs, tests.
- [x] (done) Add `--verbose` CLI mode (new flag; `-v` is taken by `--version`):
      PM-detection reason, cache hit/miss, fetch timings, ignored-flags upfront,
      engine decisions. Needs product-spec addition in AGENTS.md + docs + tests.

## Suggested additions (approved for listing, not started)

- [x] (done) Document `--save-exact`/`-E` as first-class flags (engines already map
      them from `extraArgs`; missing from help/README table). Docs + help text.
- [x] (done) Fix test hermeticity: `test/npm.test.ts` "NPM_TOKEN is sent as a Bearer
      header" fails on machines with a token in `~/.npmrc` (file token beats env).
      Isolate HOME / clear `loadNpmrc` cache in tests.
- [x] (done) Add `nps doctor`: PM detection, registry reachability, cache status in
      one command. Pairs with `--verbose`. Largest item — do last.
