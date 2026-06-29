---
type: Reference
title: Release Automation
description: Explains the semantic commit, versioning, changelog, GitHub release, and npm publishing workflow.
tags:
  - journeytest
  - releases
  - semver
timestamp: 2026-06-29T10:33:26Z
source_files:
  - ../../AGENTS.md
  - ../../CHANGELOG.md
  - ../../CONTRIBUTING.md
  - ../../README.md
  - ../../commitlint.config.cjs
  - ../../package.json
  - ../../release.config.cjs
  - ../../.github/workflows/ci.yml
---

# Release Automation

JourneyTest uses Conventional Commits and semantic-release to turn merged
changes on `main` into SemVer releases.

## Commit Contract

Every commit should use:

```text
type(optional-scope): concise imperative summary
```

Allowed types are `feat`, `fix`, `perf`, `docs`, `refactor`, `test`, `build`,
`ci`, `chore`, and `revert`. Breaking changes use either `type!` in the header
or a `BREAKING CHANGE:` footer.

CI runs commitlint against pull request commits and pushed commits so release
automation can derive versions from Git history.

## Version Mapping

Semantic-release calculates the next version from commits since the latest
`v*` release tag:

- `feat`: minor release
- `fix` and `perf`: patch release
- breaking changes: major release
- `docs`, `refactor`, `test`, `build`, `ci`, `chore`, and `revert`: included in
  release notes when a release happens, but no release by themselves unless
  breaking

## Release Job

On a push to `main`, the `release` job runs after validation. It:

1. Generates release notes from commits since the last tag.
2. Updates `CHANGELOG.md`, `package.json`, and `package-lock.json` to the
   release version during release preparation.
3. Commits release metadata with `chore(release): <version> [skip ci]`.
4. Tags the release, publishes the package to npm with provenance where
   supported, and creates the GitHub release.

The job supports npm Trusted Publishing through GitHub OIDC. If trusted
publishing is not configured, provide an `NPM_TOKEN` repository secret with npm
publish permission.

Because the workflow commits release metadata back to `main`, branch protection
must allow the workflow token to push that release commit or the release job
must be configured with another token that has permission to do so.

## Bootstrap Tag

The repository history currently has a published `0.1.1` release commit but no
Git release tag. Before the first semantic-release run, create and push this
baseline tag:

```bash
git tag v0.1.1 6cbb66d
git push origin v0.1.1
```

After that, semantic-release owns release commits, changelog updates, tags, and
npm publishing.
