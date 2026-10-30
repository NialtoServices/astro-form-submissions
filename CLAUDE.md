# CLAUDE.md

A public, general-purpose form submissions toolkit for Astro sites, published to npm with its README and `CHANGELOG.md`.

## Hard rules

- **The only real domains are services the package talks to or documents**, such as a provider's API host. Fixtures
  and examples use placeholders such as `ada@example.com` and `my-site.example.workers.dev`.
- **Type-narrowing guards use the negated form** (`if (!(error instanceof Error)) return`,
  `if (!isRecord(value)) return`), not the `!== true` comparison; the codebase is uniform in it.
- **Tests are titled as plain behaviour statements** (`it('refuses a …')`), not `is expected to …`. A `describe` names
  its unit bare (`createFormRoute body limit`), and conditions sit in titles rather than `when …` / `with …` groups.
- **The `astro` peer range rises only when the implementation needs the newer version.** Development dependencies can
  be bumped freely, for a security advisory or otherwise, but `peerDependencies` is what every site must install.
- **The owner cuts releases; don't tag or publish unless asked.** The steps are in `docs/releasing.md`.

## Changelog and versions

- **`CHANGELOG.md` is how a site learns what an upgrade asks of it.** A commit that changes what a site sees or must do
  (an export, an option, a default, a response, an email, a refusal) adds its entry in that same commit, so the file
  never falls behind; internal work (tests, refactors, tooling) gets none. Anything a site must act on goes under
  **Upgrading** as a numbered step that says what to do, not only what changed.
- **A version isn't released until its tag is pushed and npm lists it.** A release commit is audited before it's
  tagged, so neither `version` in `package.json` nor a `Release x.y.z` commit means it shipped: check
  `git ls-remote --tags origin` and `pnpm view @nialto-services/astro-form-submissions versions`. Entries go under
  `## [Unreleased]`, or in the pending version's section while its release commit awaits the tag, with no new bump.
- **Deprecated aliases and migration warnings are only for APIs a published version shipped.** Changing an API no
  release has carried is just a change, and needs no alias, warning or Upgrading step.

## Verify before finishing

The full gate is the `prepublishOnly` script, which CI runs step by step alongside `pnpm audit --prod`. `test:browser`
needs Playwright's browsers (`pnpm exec playwright install`), and `test:dist` checks the compiled package, so it needs
a fresh `pnpm build`.
