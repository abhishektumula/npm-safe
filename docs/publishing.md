# Publishing `npm-safe` to the npm registry

Step-by-step release guide for this package (registry name `npm-safe`,
binary `nps`). It follows the flow of npm's own
[Creating and publishing scoped public packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages)
— account, review, test, publish, verify — adapted to this repo.
Note where scoped vs unscoped differs: `npm-safe` is **unscoped**, so it
defaults to public; `--access public` below is explicit but harmless, and
required only for `@scope/*` names.

## 0. Prerequisites

- Node.js with npm (any recent LTS):
  ```bash
  node --version && npm --version
  ```
- An npm user account ([signup](https://www.npmjs.com/signup)) if you don't
  have one.
- For **direct publishing** npm requires either **2FA enabled** on the
  account, or a **granular access token (GAT) with bypass-2FA**. Enable 2FA
  at [npmjs.com → Account Settings → Two-Factor Authentication](https://www.npmjs.com/settings/security),
  or mint a token at [Access Tokens](https://www.npmjs.com/settings/tokens)
  (choose "Granular Access Token", read+write on this package, bypass 2FA).
  Alternative without 2FA on the CLI: [staged publishing](#8-alternative-staged-publishing).

## 1. Check the name is free

```bash
npm view npm-safe version
```

- `404 Not Found` → the name is available, proceed.
- A version number → the name is taken; pick another `name` in
  `package.json` (and update this guide's commands accordingly).

## 2. Confirm the packaging fields

These are already set in this repo — verify, don't retype:

```bash
node -e "const p = require('./package.json'); console.log(p.name, p.version, JSON.stringify(p.bin), JSON.stringify(p.files))"
# expect: npm-safe <version> {"nps":"./dist/index.js"} ["dist","README.md"]
```

What each field does:

| Field            | Value                   | Why                                                                                                                  |
| ---------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `name`           | `npm-safe`              | Registry name (unscoped → public by default)                                                                         |
| `bin.nps`        | `./dist/index.js`       | Installed command. Points at the **built** bundle — never at `./index.ts`, so it runs under plain Node, not just Bun |
| `files`          | `["dist", "README.md"]` | Tarball allowlist: only the bundle + readme ship                                                                     |
| `prepublishOnly` | `bun run build`         | Rebuilds `dist/` automatically on every `npm publish`                                                                |

## 3. Sync the version

- Semver: **patch** for fixes, **minor** for flags/managers/sources, **major**
  for breaking CLI changes.
- Bump in **two** places (they must match):
  ```bash
  # package.json:  "version": "0.1.0"  →  "version": "0.2.0"
  # src/cli.ts:   const VERSION = "0.1.0"  →  const VERSION = "0.2.0"
  ```
  Check:
  ```bash
  grep '"version"' package.json && grep 'const VERSION' src/cli.ts
  ```

## 4. Review the tarball contents

Never publish secrets, scratch files, or editor dirs. The `files`
allowlist already excludes everything except `dist/` + `README.md` —
confirm with a dry run (expect exactly 3 files):

```bash
bun run build
npm pack --dry-run
# expect: dist/index.js, README.md, package.json — nothing else
```

## 5. Test before publishing

Run the repo's own gates plus the packaging checklist from
[`packaging.md`](./packaging.md):

```bash
bun run check                    # tsc --noEmit, must be clean
bun test --coverage              # must pass, ≥90% lines+functions
bun ./index.ts add left-pad --dry-run --pm npm   # intel + engine plan
bun ./index.ts run --dry-run build               # passthrough, no spawn
node ./dist/index.js --help      # Node-compatible bundle (not just Bun)
```

Then install the packed tarball globally from a scratch directory, exactly
as a user would (this is npm's `npm install /path/to/package` test, plus
the binary on `PATH`):

```bash
cd "$(mktemp -d)"
npm pack /path/to/npm-safe --dry-run >/dev/null  # sanity: builds file list
npm install -g /path/to/npm-safe/npm-safe-<version>.tgz
nps --version                   # expect the version from step 3
nps add left-pad --dry-run --pm npm   # end-to-end smoke as a real user
```

## 6. Log in

```bash
npm login
npm whoami                       # expect your username; proves auth works
```

If you use a token instead (CI, headless machines):

```bash
npm login --auth-type=legacy   # then paste the GAT when prompted
# or non-interactive:
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > ~/.npmrc
npm whoami
```

Never commit that `~/.npmrc` line anywhere — tokens stay out of git.

## 7. Publish

From the package root, on a clean tree (`git status` shows nothing but the
intended release commit):

```bash
git status --short               # must be clean
npm publish --access public
```

What happens: `prepublishOnly` rebuilds `dist/`, npm uploads the 3-file
tarball. For **scoped** names (`@you/pkg`) the `--access public` flag is
**required** (scoped defaults to private); for unscoped `npm-safe` it is
accepted and makes the intent explicit.

## 8. Verify the release

```bash
npm view npm-safe version        # expect the new version
npm view npm-safe dist.tarball   # the file users download
```

- Open `https://www.npmjs.com/package/npm-safe` — it should say `public`
  below the package name.
- From a scratch directory (or another machine), install as a stranger:
  ```bash
  npm install -g npm-safe
  nps --version
  ```

## 9. Publishing updates

1. Make the change on `main` (one commit per set, per `AGENTS.md` §8).
2. Bump `package.json` + `src/cli.ts` `VERSION` together (see step 3).
3. Repeat steps 4–8. You cannot republish over an existing version number —
   `E403 "You cannot publish over the previously published version"` means
   bump first.

Related maintenance commands:

```bash
npm deprecate npm-safe@"<version>" "message"   # warn users off a bad release
npm dist-tag ls npm-safe                        # check the `latest` pointer
```

Unpublishing is deliberately hard (npm [unpublish policy](https://docs.npmjs.com/policies/unpublish)):
within 72 hours only, and only if no other packages depend on it. Prefer
`npm deprecate` for mistakes.

## 10. Alternative: staged publishing

If you can't do 2FA on the publishing machine, stage from CI and approve
interactively (approval always prompts for 2FA):

```bash
npm stage publish                # submits to the staging area, no 2FA needed
npm stage list npm-safe          # find the stage ID
npm stage approve <stage-id>     # 2FA prompt, then it goes live
```

A GAT with bypass-2FA does **not** bypass approval-time 2FA. Details:
[Staged publishing](https://docs.npmjs.com/staged-publishing).

## Troubleshooting

| Error                                                   | Cause → fix                                                                                                                                              |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `E403 ... --access public` / `402 Payment Required`     | Scoped name without public access → add `--access public`; or you lack rights to that scope                                                              |
| `E404` on `npm view` after publish                      | Name taken by someone else, or replication lag — wait a minute and retry                                                                                 |
| `E403 cannot publish over previously published version` | Bump `version` (step 3); registry versions are immutable                                                                                                 |
| OTP / `E401` at publish                                 | 2FA prompt — enter the authenticator code; for headless, use a GAT (step 0/6)                                                                            |
| `EACCES` on `npm install -g`                            | Global prefix not writable → [fix perms](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally), never `sudo npm` |
| Stale `nps` after `bun link` (dev only)                 | Linked bins point at `dist/` — rerun `bun run build` after every change                                                                                  |
