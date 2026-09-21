Security + health review of npm-safe (nps). No code changed. Typecheck clean, bun test 112 pass, coverage 93% lines / 97% funcs, bun audit clean.
What's already done right
- No shell execution anywhere: single spawnSync(pm, args, …) boundary in src/install.ts:261, argv-only, no shell:true, no string building.
- No secrets, no dotenv, no eval/exec, no Bun.* in src/, .env* gitignored.
- Prompt fails closed: non-TTY → false (src/prompt.ts:14), strict y/yes only, default N.
- Network is bounded per-request (AbortSignal.timeout in src/npm.ts:30, src/snyk.ts:17), one dead source can't kill the screen (Promise.allSettled in src/inspect.ts:14).
- Tests never hit network (stubbed fetch, temp dirs, dry-run only).
Findings (ordered)
1. Validate --pm early, don't rely on late engine guards — src/pm.ts:18, src/cli.ts:210
detectPm() lowercases any override and returns it unchecked. Today performInstall's switch and performPassthrough's ALL_PMS check happen to reject unknown managers, so arbitrary-binary exec isn't possible — but it's defense-by-accident. A future engine addition could open it.
Suggestion: validate against ALL_PMS in detectPm()/parseArgs() and fail fast with supported: npm|bun|pnpm|yarn|brew; type pm as the union, not string.
2. Sanitize registry strings before rendering — src/npm.ts:36, src/render.ts:43
description/author/repoUrl/license go straight to the terminal with ANSI paint. A malicious package can embed ESC/OSC sequences (clear screen, fake [y/N], hyperlink spoof) — ironic in a safety tool.
Suggestion: strip control chars (\x1b, \x07, \r, C0/C1) in cleanAuthor/cleanRepoUrl/description path or one sanitize() at render.
3. Cap Snyk response size — src/snyk.ts:20
await res.text() is unbounded, then regexed. A huge/odd page = memory + slow regex.
Suggestion: check content-length, cap at ~1MB, treat over-limit as n/a (existing graceful path).
4. Bound total transitive-lookup time — src/deps.ts:25
MAX_NODES=1200, concurrency 20, 8s per fetch → worst case minutes of hanging on a bloated/malicious tree, no global deadline.
Suggestion: overall deadline (~15–20s) for countTransitive(), then return partial counts with a "truncated" flag.
5. Validate package names + reject non-registry specs explicitly — src/spec.ts:35, src/npm.ts:28, src/install.ts:98
encodePkg() leaves . unencoded, so .. segments survive (stays same-host since base URL is fixed, but can hit unexpected registry paths). More important: Arborist add accepts file:/link:/git+/http: specs, currently blocked only incidentally by the intel gate (src/cli.ts:250 → "nothing to install").
Suggestion: allowlist npm names (npm-package-arg or equivalent regex), reject file:/link:/git:/http: with a clear error before fetch and before engine — don't depend on lookup-failure to block them.
6. Don't swallow spawn errors — src/install.ts:261
res.status ?? 1 drops res.error (e.g. binary missing), producing a generic "exited with code 1".
Suggestion: surface res.error.message in the InstallError.
7. Consider a blocking signal, not just display — product-level
Score 0 and score 90 install identically (unless Snyk unreachable). Users may misread "intel shown" as "vetted".
Suggestion: opt-in --min-score N (or at least a red warning + require explicit y on score < threshold / n/a).
General improvements
- Single-source version: VERSION in src/cli.ts:9 duplicates package.json:3. Import/inject at build to prevent drift.
- Pin @types/bun: latest → exact version; ^ ranges elsewhere are fine since bun.lock is committed, but published tarballs resolve fresh.
- No CI: no .github/workflows, no scheduled bun audit / Dependabot. Add minimal CI (check + test --coverage + bun audit) since AGENTS.md already defines the gates.
- npm audit can't run (bun-lock only). Either document bun-first auditing or generate a package-lock in CI for a second opinion.
- Retry/backoff: parallel intel + BFS burst can 429. Add small retry with Retry-After respect in one fetch wrapper.
- Privacy line in README: state that package names are sent to registry.npmjs.org + security.snyk.io.
- brew dev mapping (src/install.ts:223): dev == normal for brew — harmless but document that --dev is a no-op there.
Suggested order: 1 → 2 → 5 → 3 → 4 → 6, then version pinning + CI.
