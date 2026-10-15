# `--json` output (schemaVersion 1)

`--json` prints exactly one JSON document to stdout and nothing else; human
status lines go to stderr. It never prompts: without `-y` it reports and
stops (policy still applies and sets the exit code).

```jsonc
{
  "schemaVersion": 1,            // bumped on any breaking change
  "nps": "0.1.2",
  "command": "install",          // "install" | "check" | "scan"
  "policy": {
    "active": true,              // any policy rule configured
    "minScore": 60,              // null when unset
    "violations": [              // empty when passed
      { "query": "pkg", "rule": "min-score", "message": "pkg@1.0.0: health 30/100 is below min-score 60" }
    ],
    "passed": false              // false => exit code 3
  },
  "packages": [ /* PackageReport[] */ ]
}
```

`violations[].rule`: `min-score` | `health-unknown` | `deprecated` |
`vulnerable` | `license`.

`PackageReport` (see `src/types.ts`):

| Field | Meaning |
| ----- | ------- |
| `query` | what the user typed (`express@5`) |
| `meta` | registry data (`name`, `version`, `license`, `deprecated`, `installScripts`, …) or `null` when the lookup failed |
| `metaError` | why `meta` is `null` |
| `health` | `{ score: 0–100 \| null, breakdown, unparsed?, stale? }` |
| `vulns` | `{ count, ids[≤10], worst, stale? }`; `null` = OSV unreachable; absent = not queried |
| `signals` | `{ deprecated, installScripts[], lookalike }` |
| `directCount` / `transitiveCount` / `totalCount` | dependency counts (`scan` skips the crawl: transitive is 0) |
| `truncated` | the transitive crawl hit its budget |
| `stale` | any source answered from an expired cache (offline) |
| `isNonRegistry` | `user/repo`, `file:` … intel skipped |

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | ok (also: you declined the prompt) |
| 1 | error: bad flags, install failure, unsupported combination |
| 3 | blocked by policy |
| 4 | intel unavailable: every lookup failed |

Passthrough commands return the package manager's own exit code.
