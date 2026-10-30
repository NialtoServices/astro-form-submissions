# Releasing

Releases publish from CI, never from a workstation, and only the owner cuts one.

1. **Commit the release.** Bump `version` in `package.json`, rename `## [Unreleased]` in `CHANGELOG.md` to
   `## [<version>] - <date>` with a fresh empty `## [Unreleased]` above it, update the compare links at the foot of the
   file, and commit as `Release <version>`.
2. **Audit it before tagging.** The release commit is reviewed before anything ships; a fix made then belongs to the
   pending version, with its entry in that version's changelog section and no further bump.
3. **Tag and push.** Tag the commit being released `v<version>` and push the tag. CI's `verify` job fails when the tag
   doesn't match `package.json`, and `pnpm test:dist` fails when the changelog has no section for the package's version.
4. **Approve the staged release.** The `publish` job in `.github/workflows/ci.yml` runs only after `verify` passes for
   that tag, and stages the release through npm trusted publishing, which needs no npm token and attaches provenance. A
   staged release isn't installable until the owner approves it on npmjs.com (Staged Packages) or with
   `npm stage approve <stage-id>`, both behind two-factor authentication; the trusted publisher allows staging only, so a
   plain `npm publish` from CI is refused.
