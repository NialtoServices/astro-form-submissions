# CLAUDE.md

## Maintaining this file

This file carries what the codebase **cannot** tell you — constraints, rationale, gotchas, business rules — and is not
a description of the code. Derivable content here is worse than no content at all, because the file reads as ground
truth and so misleads the moment it drifts.

- **The codebase wins.** Where this file and the code disagree, the code is right and the line is stale. Verify against
  the source before acting on anything that reads like a fact about the current implementation, and fix or delete the
  line once you find the drift.
- **Before adding anything, ask whether a session could work it out** with `ls`, `cat`, `grep`, or the package
  manifest. If it could, don't add it: no directory layouts, dependency lists, component rosters, frontmatter or type
  enumerations, function signatures, or standard commands.
- **Do add** what the code can't explain: why something is the way it is, what breaks if it changes, prohibitions, copy
  and business rules, and non-obvious build or environment steps.
- **Prefer a pointer to a copy.** Name the file that holds the detail rather than restating it, so there is one source
  of truth and nothing to keep in sync.
- **Record constraints, not progress.** This file is not a changelog.

## Keep the package generic

This is a public, general-purpose package, and its README ships to npm. Never write personal or identifying information
into the repository: no names of people or businesses, real domains, email addresses, phone numbers or account
identifiers. That applies to code, comments, tests, fixtures, the README, commit messages and pull requests. Fixtures and
examples use reserved placeholders such as `example.com`, `ada@example.com` and `my-site.example.workers.dev`.

Explain a change by what it does and the general shape of the problem it handles, never by who needed it or where it
came up. A comment, test name or commit message says "cap the request body", not "fix the crash a site reported".

## Releasing

Releases publish from CI, never from a workstation: bump `version` in `package.json`, commit, tag the commit
`v<version>` and push the tag. The `publish` job in `.github/workflows/ci.yml` runs only after `verify` passes for
that tag, and publishes through npm trusted publishing, which needs no npm token and attaches provenance. The owner
cuts releases; don't tag or publish unless asked.
