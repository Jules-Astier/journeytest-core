# AGENTS.md

Project instructions for agents working in `journeytest-core`.

## Documentation Contract

This repository uses an OKF-style documentation bundle in `docs/` for durable
project knowledge. Before finishing any change, decide whether it affects how
JourneyTest works, how users configure it, or how maintainers extend it.

Update documentation in the same change when touching any of these surfaces:

- Public CLI commands, flags, output files, exit behavior, auth behavior, or
  package setup.
- Journey, tester profile, data lifecycle, verdict, artifact, or run result
  schemas.
- Runner, browser driver, director, bookmark curator, reporter, lifecycle,
  redaction, or video behavior.
- Examples, bundled skills, authoring guidance, or contributor workflow.
- Any README-visible feature, limitation, or troubleshooting path.

At minimum, update the most specific concept file under `docs/` and refresh
`docs/log.md`. Also update `README.md` when the changed behavior is part of the
normal user-facing quickstart or CLI reference.

## OKF Documentation Rules

- Treat `docs/` as the OKF bundle root.
- Keep `docs/index.md` as the top-level map and OKF version declaration.
- Keep subdirectory `index.md` files short and free of YAML frontmatter.
- Keep `docs/log.md` as a chronological documentation change log and free of
  YAML frontmatter.
- Every other Markdown concept file under `docs/` must start with YAML
  frontmatter including `type`, `title`, `description`, `tags`, and `timestamp`.
- Prefer one concept per file. If a page grows to cover multiple concepts, split
  it and update the nearest `index.md`.
- Use relative links that work from the file's location.
- When documenting code behavior, include `source_files` in frontmatter pointing
  at the files that currently define the behavior.

## Commit and Release Rules

Use Conventional Commit messages for commits in this repository. The first line
must use:

```text
type(optional-scope): concise imperative summary
```

Allowed release-aware types are `feat`, `fix`, `perf`, `docs`, `refactor`,
`test`, `build`, `ci`, `chore`, and `revert`.

Semantic-release maps commits to versions on pushes to `main`:

- `feat` creates a minor release.
- `fix` and `perf` create a patch release.
- `type!` or a `BREAKING CHANGE:` footer creates a major release.
- `docs`, `refactor`, `test`, `build`, `ci`, `chore`, and `revert` appear in
  release notes when included with a release, but do not create a release by
  themselves unless they are breaking.

Do not hand-edit `CHANGELOG.md` or release version commits during normal
feature work. The release workflow generates those with
`chore(release): <version> [skip ci]`.

## Validation

Before handing off code changes, run the most relevant checks:

```bash
npm run typecheck
npm test
```

For docs-only changes, a full test run is not required unless the docs include
generated command output or examples that need verification.
