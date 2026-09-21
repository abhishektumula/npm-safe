# Extending npms

Three recipes. Each ends with the same verification; follow
[AGENTS.md](../AGENTS.md) §8 (commit policy) when you land the change.

Shared verification for every recipe:

```bash
bun run check && bun test --coverage   # green + ≥90% or add tests
```

## Add a package manager (e.g. `deno`)

1. **Detect it** — `src/pm.ts`
   - Add its marker to `detectPm()` in the right priority position and to
     `ALL_PMS`. Detection is read-only and local (lockfiles,
     `packageManager` field); never read global config.
2. **Install with it** — `src/install.ts`
   - If it ships a programmatic install API (like npm's Arborist or
     yarn's core): add an `installWithX()` adapter and a `case` in
     `performInstall()`. Lazy-`import()` the library; throw `InstallError`
     with a clear message when it is missing or the spec is invalid.
   - If it doesn't (like pnpm/bun): add its `add`/`--dev` argv to
     `BINARY_INSTALL_ARGS`. Argv arrays only — never shell strings.
   - Add its engine label to `engineFor()`.
3. **Surface it** — help text in `src/cli.ts` (`--pm` line), `README.md`
   manager table, `docs/packaging.md` if it affects `bin`.
4. **Test it** — `test/pm.test.ts` (detection via temp dirs),
   `test/install.test.ts` (dry-run plan; binary paths never spawn in
   tests — use `--dry-run` or harmless probes like `--version`).

## Add an intel source (e.g. download counts)

1. **Fetch it** — new `src/<source>.ts` (one module per source) exporting an
   `async fetch…()` that never throws unhandled (return null/empty on
   failure so one dead source can't kill the screen). Route HTTP through
   `fetchWithRetry()` from `src/fetch.ts` (per-attempt timeout, one
   429/503 retry honoring `Retry-After`) instead of raw `fetch()`.
2. **Type it** — extend the interfaces in `src/types.ts`
   (`NpmMeta`, `Health`, or `PackageReport`).
3. **Wire it** — call it in `inspectOne()` inside `src/inspect.ts`,
   in parallel with the existing fetches (`Promise.allSettled`).
4. **Render it** — `src/render.ts` (full card; compact rows stay minimal).
   Every string from the network is untrusted: pass it through
   `sanitizeTerminal()` from `src/sanitize.ts` before painting, so a
   hostile package can't inject terminal escape sequences.
5. **Test it** — `test/<source>.test.ts` by stubbing `globalThis.fetch`
   (success mapping, 404, 500, throw). Never hit the network in tests.

## Add a flag (e.g. `--pin`)

1. **Parse it** — `src/cli.ts` `parseArgs()`: set a field on `CliOptions`
   (declare it in `src/types.ts`). Unknown user flags belong in
   `extraArgs`, never in new one-off fields.
2. **Honor it** — where the flag takes effect (`performInstall()` engines,
   `render()`, …). Engines map known flags and report the rest ignored;
   binary installers forward `extraArgs` verbatim.
3. **Document it** — `helpText()` table, `README.md` flags table.
4. **Test it** — `test/cli.test.ts` (parsing) + the suite of whatever
   module honors it.

## Conventions for all three

- One module per concern; match existing style; no drive-by refactors.
- Pure, network-free logic must be unit-testable (see `spec.ts`,
  `prompt.ts` as models).
- `bun test --coverage` must stay ≥90% lines+functions in the same set.
- Update `README.md`/`docs` in the same set when user-facing behavior moves.
