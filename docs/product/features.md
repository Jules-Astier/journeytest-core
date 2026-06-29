---
type: Feature Catalog
title: JourneyTest Feature Catalog
description: Catalogs the user-facing capabilities currently provided by JourneyTest.
tags:
  - journeytest
  - features
  - cli
timestamp: 2026-06-29T10:36:52Z
source_files:
  - README.md
  - package.json
  - src/cli.ts
  - src/core/authoring.ts
  - src/core/schemas.ts
  - src/runner/runJourney.ts
---

# JourneyTest Feature Catalog

## Authoring

- `journeytest init` creates a starter authoring tree with one tester profile
  and one journey.
- `journeytest new profile` and `journeytest new journey` generate deterministic
  JSON templates.
- `journeytest draft journey` creates richer journey JSON from command flags or
  a structured local JSON input.
- `journeytest schema` prints JSON Schema documents for profile, journey,
  lifecycle, or all authoring schemas.
- `journeytest lint` validates schema shape and catches weak authoring such as
  missing blockers, generic fail criteria, or critical pass criteria without
  required evidence.
- `journeytest validate` checks journey/profile compatibility and allowed
  origins.
- The package publishes `skills/journeytest-author`, an agent skill for writing
  and reviewing tester profiles, journey JSON, and data lifecycle setup. It can
  be installed from GitHub with `npx skills add` or synced from `node_modules`
  with `npx skills experimental_sync`.

## Execution

- `journeytest run` accepts one journey file or a directory of journey JSON
  files.
- Directory runs recursively collect `*.json` journey files and can filter by
  tags, journey ids, excluded tags, excluded journey ids, rerun-failed inputs,
  and deterministic shard selection.
- Runs can use retries, per-journey timeouts, headed browser mode, stored browser
  state, viewport overrides, and curated device presets.
- Parallel runs support `shared-tabs` for the `agent-browser` driver or
  `isolated-sessions` for full browser session isolation.

## Evidence and Reports

- Each journey writes `events.ndjson`, `run.json`, `report.md`,
  `dashboard.html`, screenshots, snapshots, console captures, network captures,
  UI-change timelines, and video artifacts when enabled.
- Action clip video records short clips around browser actions and stitches them
  into `video.webm` when `ffmpeg` is available.
- Dashboard bookmarks come from UI actions and can be post-processed by the Pi
  bookmark curator unless disabled.
- Suite runs write a run-level dashboard and `history.json` summary.
- CI outputs can include JUnit XML, GitHub Actions annotations, and compact
  summary JSON.

## Data and App Lifecycle

- Journey data lifecycle supports setup, preflight, postcondition, and cleanup
  operations.
- Suite lifecycle can prepare and clean shared data around all selected
  journeys.
- App lifecycle can start an app under test, allocate local ports, override
  journey app targets, and write lifecycle artifacts.
- Built-in data lifecycle providers support Convex, local scripts, and HTTP.

## Safety

- Allowed origin validation constrains navigation.
- Auth files and browser state files are resolved explicitly and kept out of Git
  by project ignore rules.
- Text artifacts pass through redaction for common secret-shaped values, auth
  headers, cookies, browser storage, lifecycle values, and configured redact
  values. Screenshots and video remain visual evidence and cannot be text
  redacted.
