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

## Changelog

`CHANGELOG.md` ships with the package, and it's how a site learns what an upgrade asks of it. A commit that changes what
a site sees or must do (an export, an option, a default, a response, an email, a refusal) adds its entry under
`## [Unreleased]` in that same commit, so the file never falls behind. Anything a site must act on goes under
**Upgrading** as a numbered step that says what to do, not only what changed. Internal work (tests, refactors, tooling)
gets no entry. The rules under "Keep the package generic" apply here too.

## Releasing

Releases publish from CI, never from a workstation: bump `version` in `package.json`, rename `## [Unreleased]` in
`CHANGELOG.md` to `## [<version>] - <date>` with a fresh empty `## [Unreleased]` above it, update the compare links at
the foot of the file, commit, tag the commit `v<version>` and push the tag. `pnpm test:dist` fails if the changelog has
no section for the package's version. The `publish` job in `.github/workflows/ci.yml` runs only after `verify` passes for
that tag, and stages the release through npm trusted publishing, which needs no npm token and attaches provenance.
A staged release isn't installable until the owner approves it on npmjs.com (Staged Packages) or with
`npm stage approve <stage-id>`, both behind two-factor authentication; the trusted publisher allows staging only, so a
plain `npm publish` from CI is refused. The owner cuts releases; don't tag or publish unless asked.
