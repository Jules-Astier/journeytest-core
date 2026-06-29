# Contributing

Thanks for helping improve JourneyTest.

## Development

Use Node.js 22 or newer.

```bash
npm install
npm run validate
```

Useful scripts:

```bash
npm run build
npm run typecheck
npm test
npm run dev -- --help
```

## Pull Requests

- Keep changes focused.
- Add or update tests for behavior changes.
- Run `npm run validate` before opening a pull request.
- Update the relevant OKF docs under `docs/` when changing public behavior,
  schemas, generated artifacts, extension points, examples, or workflows.
- Update `README.md` when changing quickstart-critical CLI behavior, schemas, or
  package setup.

## Commit Messages

Use Conventional Commit messages:

```text
type(optional-scope): concise imperative summary
```

Allowed types are `feat`, `fix`, `perf`, `docs`, `refactor`, `test`, `build`,
`ci`, `chore`, and `revert`.

Release automation uses those commits on `main`:

- `feat` creates a minor release.
- `fix` and `perf` create a patch release.
- `type!` or a `BREAKING CHANGE:` footer creates a major release.
- Other allowed types are included in release notes when a release happens, but
  do not create a release by themselves unless they are breaking.

## Release Checks

Before publishing or checking package contents locally:

```bash
npm run release:check
```

To preview the release that semantic-release would calculate from the current
Git history:

```bash
npm run release:dry-run
```
