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
- Update `README.md` when changing public CLI behavior, schemas, or package setup.

## Release Checks

Before publishing:

```bash
npm run release:check
```
