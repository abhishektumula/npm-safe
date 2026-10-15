# Security

`nps` is a safety screen, so its own hygiene matters.

## Reporting a vulnerability

Open a private security advisory on GitHub
(Security → Report a vulnerability) rather than a public issue. Include the
version (`nps --version`), what you did, and what you expected. Expect an
acknowledgement within a few days.

## What nps guarantees

- No shell strings: installs and passthrough spawn argv arrays only.
- Registry, Snyk and OSV text is sanitized before it touches your terminal.
- Package names are validated before any fetch or engine call.
- Tokens go only to the registry host and are never printed.
- No telemetry. Package names are sent to `registry.npmjs.org` (or your
  configured registry), `security.snyk.io` and `api.osv.dev`.

## What nps does not guarantee

- A good score is not a vetting. Snyk's score is a heuristic; OSV only knows
  published advisories; install-script and typosquat signals are hints.
- Transitive dependencies are counted, not scored.
- Intel failures fail open (install proceeds with a warning) unless a policy
  such as `--min-score` is set.
