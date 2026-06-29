---
type: Architecture
title: How JourneyTest Works
description: Explains the runtime flow and component boundaries for a JourneyTest run.
tags:
  - journeytest
  - architecture
  - runner
timestamp: 2026-06-29T10:33:26Z
source_files:
  - src/core/schemas.ts
  - src/core/validation.ts
  - src/cli.ts
  - src/runner/runJourney.ts
  - src/directors/types.ts
  - src/drivers/types.ts
  - src/factories/index.ts
---

# How JourneyTest Works

JourneyTest is organized around narrow boundaries that make the agent, browser,
runner, reporters, and lifecycle adapters replaceable.

## Main Flow

1. The CLI reads journey JSON and tester profile JSON.
2. Zod schemas validate shape, required fields, ids, and enum values.
3. Validation checks journey/profile compatibility and app allowed origins.
4. The CLI resolves auth, browser settings, lifecycle config, selection filters,
   parallelism, retries, and output directories.
5. The runner creates a run directory and append-only event recorder.
6. Journey data lifecycle setup and preflight run before browser execution when
   the journey declares `dataLifecycle`.
7. The browser driver starts with the journey app target, allowed origins,
   session settings, optional stored state, and browser environment.
8. The director receives the journey, tester profile, browser tool surface,
   artifact directories, event recorder, action video recorder, and UI-change
   options.
9. The director performs the journey and returns an `AgentVerdict`.
10. The runner validates and redacts the verdict, closes the browser, runs
    postconditions and cleanup, gathers artifacts, optionally curates bookmarks,
    then writes `run.json`, `report.md`, and `dashboard.html`.

## Component Boundaries

`AgentDirector` owns model-specific execution. Its contract is to run the
journey and return an `AgentVerdict`. The built-in `pi` director exposes browser
tools to Pi and requires a final structured verdict.

`BrowserDriver` owns browser automation. The interface includes navigation,
snapshotting, screenshots, actions, waits, scrolling, upload/download,
console/network capture, DOM snapshots, UI-change observation, video recording,
viewport reads, URL/title reads, and cleanup.

`EventRecorder` owns the timeline. Browser and lifecycle events are recorded as
typed timeline entries with wall-clock time, elapsed time, optional video time,
summaries, and structured data.

Reporters own presentation. The Markdown reporter writes the human report, the
dashboard reporter writes a static HTML evidence review surface, and suite
reporters write directory-run summaries and comparison history.

Factories register replaceable implementations. The default registry provides
the `pi` director, `agent-browser` browser driver, `pi` and `none` bookmark
curators, and `default`, `convex`, `script`, and `http` data lifecycle
providers.

## Run Status and Verdict Status

Run status and verdict status are separate. A run can complete at the framework
level while the agent verdict is `failed`, `blocked`, or `inconclusive`. Runner
errors and lifecycle blocks are represented in the run result independently from
the agent's criteria assessment.
