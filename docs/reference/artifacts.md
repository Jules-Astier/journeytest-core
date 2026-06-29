---
type: Reference
title: Run Artifacts
description: Reference for JourneyTest run directories, evidence artifacts, and result files.
tags:
  - journeytest
  - artifacts
  - evidence
timestamp: 2026-06-29T17:24:07Z
source_files:
  - README.md
  - src/core/schemas.ts
  - src/runner/runJourney.ts
  - src/reporters/dashboard.ts
  - src/reporters/markdown.ts
---

# Run Artifacts

Each journey run writes a run directory containing the canonical machine result,
human report, static dashboard, event stream, and evidence artifacts.

Common journey artifacts:

```text
runs/<timestamp>-<journey-id>/
  dashboard.html
  events.ndjson
  report.md
  run.json
  video.webm
  screenshots/
  snapshots/
  console/
  network/
  ui-changes/
```

Lifecycle-enabled journeys can also write:

```text
setup.json
preflight.json
postconditions.json
cleanup.json
```

Directory runs group journey directories under one suite folder and add:

```text
runs/<timestamp>-run/
  dashboard.html
  history.json
  _app-lifecycle/
  _suite-lifecycle/
  <timestamp>-journey-a/
  <timestamp>-journey-b/
```

## Canonical Result

`run.json` has `schemaVersion: "0.1"` and includes run identity, journey id,
tester profile id, run status, model metadata, optional verdict, optional error,
bookmarks, optional video processing metadata, optional data lifecycle
execution, attempts, flake metadata, quarantine metadata, browser environment,
artifacts, and timeline events.

## Human Review

`report.md` is the human-readable Markdown summary. `dashboard.html` is a static
review surface for verdict text, criteria, findings, screenshots, snapshots,
console/network captures, UI-change timelines, raw JSON, video, and bookmarks.

## Video and Bookmarks

When video is enabled, JourneyTest records one journey-scoped `video.webm`.
Bookmarks are generated from UI actions and can be curated into chapter-style
labels that seek into that recording.

## Secret Handling

Text artifacts are redacted for common secret-shaped values, API keys, tokens,
auth headers, cookies, browser storage, password-like keys, and lifecycle
redact values. Screenshots and video are visual evidence and cannot be text
redacted.
