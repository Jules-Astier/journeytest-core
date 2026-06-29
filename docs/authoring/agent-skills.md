---
type: Guide
title: JourneyTest Agent Skills
description: Explains how to install and sync the bundled JourneyTest authoring agent skill.
tags:
  - journeytest
  - skills
  - authoring
  - setup
timestamp: 2026-06-29T10:45:00Z
source_files:
  - README.md
  - package.json
  - skills/journeytest-author/SKILL.md
---

# JourneyTest Agent Skills

JourneyTest publishes the `journeytest-author` skill to help agents create,
review, and improve tester profiles, journey JSON, criteria, evidence
requirements, and data lifecycle setup.

Install it from the JourneyTest GitHub repository with Vercel's `skills` CLI:

```bash
npx skills add Jules-Astier/journeytest-core --skill journeytest-author
```

`skills add` installs to the current project by default. For Codex, the
project-local destination is `.agents/skills/`; to target Codex explicitly, run:

```bash
npx skills add Jules-Astier/journeytest-core \
  --skill journeytest-author \
  --agent codex
```

Preview the repository's available skills without installing anything:

```bash
npx skills add Jules-Astier/journeytest-core --list
```

Because `package.json` includes `skills` in the published package files, projects
that already installed `@baguette-studios/journeytest-core` can also sync from
`node_modules`:

```bash
npx skills experimental_sync --agent codex
```

`experimental_sync` is still marked experimental by the `skills` CLI. Prefer the
GitHub `skills add` command for the stable documented path, and use
`experimental_sync` when you specifically want to install whatever bundled skill
version is already present in the project's `node_modules`.

JourneyTest intentionally avoids an interactive `postinstall` prompt for skill
installation. npm install scripts can run in CI, can be disabled by package
managers, and cannot reliably decide which local agent directories should be
changed. Keep skill installation as an explicit project setup command.
