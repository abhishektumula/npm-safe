# nps — see package intel before you install

`nps` is an npm wrapper with a safety screen. Instead of blindly running
`npm install <pkg>`, run `nps install <pkg>` and see, **before anything
is written**:

- name + version, description, author, repo URL
- direct / transitive / total dependency counts
- Snyk health score `/100` with `security` / `popularity` /
  `maintenance` / `community` breakdown — when Snyk is unreachable,
  unparsable or disabled (`--no-snyk`), an **nps estimate** from the free
  structured sources (OSV advisories, weekly downloads, OpenSSF Scorecard,
  publish recency) takes its place, labelled `(nps estimate: …)`
- known advisories for that exact version (OSV.dev)
- trust facts from deps.dev: OpenSSF Scorecard, GitHub stars, verified
  build provenance, and how long ago the version was published
- red flags: deprecated, runs code on install, name close to a popular
  package (typosquat), fresh release (published under 48h ago), no source
  repository linked

…then a `[y/N]` prompt. Confirm and it installs through your project's
own package manager. 3+ packages collapse to compact rows.
(Registry name: `@hort/nps`.)

```text
$ nps check left-pad
  ◆ nps  package intel before you install
────────────────────────────────────────────────────
  ◆ left-pad v1.3.0
  String left pad
  author  azer
  repo    https://github.com/stevemao/left-pad
  deps    0 direct  0 transitive  0 total
  health  55/100 ██████░░░░
           security No known security issues  popularity Influential project
           maintenance Inactive  community Limited
  vulns   no known advisories
  ⚠ deprecated: use String.prototype.padStart()
  fetched in 412ms
────────────────────────────────────────────────────
```

**Why not just `npm audit`?** `npm audit` checks what you already have
against advisories. `nps` is the step *before* that: it screens a package
you're about to add (health, maintenance, install scripts, lookalike
names), enforces a policy in CI, and still covers existing projects with
`nps scan`. It complements `npm audit`, Snyk and Socket; it doesn't replace them.

## Install

Try it with no install (Node ≥20.17):

```bash
npx -y @hort/nps check express
```

Or install it globally and alias it:

```bash
npm install -g @hort/nps   # exposes the `nps` command
nps --version
nps alias                  # prints handy aliases (ni, nic, nscan)
eval "$(nps completions zsh)"   # also: bash, fish
```

From source: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Usage

```bash
nps install express lodash -a     # intel cards, full detail, then confirm
nps install                       # no packages: install project deps
nps i "express@5" --dry-run       # inspect only, install nothing
nps check express                 # inspect only — never installs
nps scan                          # screen this project's declared dependencies
nps doctor                        # is everything reachable and detected?
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
| `-E, --save-exact` | Pin the exact version instead of a `^` range |
| `--registry <url>` | Use a private registry (`.npmrc` + `NPM_TOKEN` also work) |
| `--pm <name>` | Force manager: `npm` \| `bun` \| `pnpm` \| `yarn` \| `brew`   |
| `--min-score <n>` | Block (exit 3) when health (Snyk, else nps estimate) is below `n`/100 or unknown |
| `--dry-run`   | Show intel only, never install                                |
| `--json`      | One versioned JSON document; never prompts ([schema](docs/json-schema.md)) |
| `--verbose`   | Diagnostics on stderr: detection, cache hit/miss, timings, ignored flags |
| `--no-cache`  | Skip the intel cache for this run                             |
| `--no-color`  | Plain output (`NO_COLOR` is honored; pipes are plain automatically) |
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

## Commands

| Command | What it does |
| ------- | ------------ |
| `nps install <pkg…>` (`i`, `add`, bare names) | intel → `[y/N]` → install |
| `nps check <pkg…>` | intel only; same as `--dry-run`. Exits 3 if policy fails |
| `nps scan [--prod]` | intel for every dependency in `package.json` (version on disk when installed), worst first |
| `nps doctor` | manager detection, config, cache, registry / Snyk / OSV / deps.dev reachability |
| `nps cache-clear` | delete nps's intel cache (named so it can't shadow `npm cache clean`) |
| `nps completions <bash\|zsh\|fish>` | print a completion script |
| `nps alias` | print shell aliases |
| `nps run\|test\|exec\|remove\|…` | passthrough to your package manager |

`scan` skips workspaces' member packages and non-registry dependencies
(`file:`, `git`, `workspace:`), and lists what it skipped.

## Policy (CI gate)

By default intel is advisory. Set a policy and violations **block**: exit
code 3, nothing installed, and `-y` does not bypass it.

```bash
nps check left-pad --min-score 70      # fails (3) if health < 70 or unknown
```

Or per project in `nps.config.json`:

```json
{
  "policy": {
    "minScore": 60,
    "blockDeprecated": true,
    "blockVulnerabilities": "high",
    "allowedLicenses": ["MIT", "ISC", "Apache-2.0"],
    "minWeeklyDownloads": 1000,
    "minReleaseAgeHours": 72
  }
}
```

`blockVulnerabilities` takes `low | moderate | high | critical` and blocks
when an advisory at or above that severity exists (advisories with no stated
severity always count). `minReleaseAgeHours` blocks versions published
more recently than that (hijacked releases are usually caught and pulled
within days); an unknown publish time passes, like unknown downloads.
`--min-score` overrides the file. A malformed file
fails open to "no policy", like the manager config below.

### Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | ok (also: you declined the prompt) |
| 1 | error: bad flags, install failure |
| 3 | blocked by policy |
| 4 | intel unavailable: every lookup failed |

Passthrough commands return the package manager's own exit code.

## Package managers

Auto-detected from your directory — lockfiles first
(`pnpm-lock.yaml` → `yarn.lock` → `package-lock.json` → `bun.lock`),
then the `packageManager` field, defaulting to `npm`. Override with `--pm`.

| Manager    | How nps installs                              |
| ---------- | ---------------------------------------------- |
| npm        | In-process via `@npmcli/arborist` (official engine) |
| yarn/pnpm/bun/brew | Their own binaries (argv-only spawn) |

`run`, `test`, `exec`, `remove`, … always pass straight through.

To opt out of a manager per project, add `nps.config.json` next to
`package.json` (every manager is enabled unless listed with
`"enabled": false`):

```json
{
  "packageManagers": {
    "brew": { "enabled": false }
  }
}
```

A disabled manager fails fast with `package manager "brew" is disabled`
before any intel or install — including via `--pm`. Missing, malformed,
or mistyped config fails open to all enabled.

`--dev` is a no-op for `brew`. Health under 40/100, unreachable, or
unparsable prints a warning before the prompt — never blocks.

The nps estimate weighs security 30% (OSV advisories for the exact
version; verified provenance tops it up), popularity 25% (weekly
downloads, log scale), maintenance 25% (Scorecard `Maintained`, else
publish recency) and community 20% (Scorecard overall, else stars).
Unknown parts drop out; under two known parts it stays `n/a`. A critical
advisory caps it at 25, high at 45, deprecation at 40 — popularity never
outweighs a known-bad version.

Private registries: `--registry`, `.npmrc` (`registry`,
`@scope:registry`, `//host/:_authToken` with `${VAR}`), or `NPM_TOKEN` —
for intel and install alike.

Intel is cached (memory + disk, 24h TTL) so repeat installs return in
single-digit ms with zero network — first run warms the cache. Multiple
packages fetch in parallel with shared dedup. If the network is down, an
expired entry (up to 7 days old) is used and labelled
`(offline: showing cached data)`. Disable with `--no-cache` or
`NPS_NO_CACHE=1`, override the dir with `NPS_CACHE_DIR`, wipe it with
`nps cache-clear`.

## Privacy

Inspecting a package sends its name (and, for advisories, its version) to
the registry (metadata), `security.snyk.io` (health), `api.osv.dev`
(advisories), `api.npmjs.org` (download counts) and `api.deps.dev`
(Scorecard, provenance, publish date; public npm packages only). Nothing else leaves your machine — no
telemetry, no accounts. Tokens go only to the registry host and are
never printed.

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `(nps estimate: snyk unreachable)` | Snyk is down or blocked; the score comes from OSV/downloads/deps.dev instead. Run `nps doctor` |
| `(nps estimate: snyk parse failed)` | Snyk changed its page layout; the estimate stands in. Open an issue |
| `health n/a (snyk unreachable)` | Snyk *and* the free sources had too little data. Install proceeds unless a policy is set; `--min-score` treats unknown as a failure |
| `registry responded 401/403` | Private registry: set `NPM_TOKEN`, `--registry`, or `.npmrc` auth |
| Prompt never appears in CI | Not a TTY: pass `-y`, or use `nps check` as a gate |
| `package manager "brew" is disabled` | `nps.config.json` disables it |
| Odd results after a layout change | `nps cache-clear` |
| Anything else | `nps doctor`, then re-run with `--verbose` |

**Platforms:** macOS and Linux (Node ≥20.17). Windows is not supported yet.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) (setup, tests), [AGENTS.md](AGENTS.md)
(architecture, engine rules, commit policy),
[docs/extending.md](docs/extending.md) (add a manager, source or flag),
[docs/packaging.md](docs/packaging.md) (build, publish, release),
[CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md).
