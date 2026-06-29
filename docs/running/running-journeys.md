---
type: Operations Guide
title: Running Journeys
description: Describes how JourneyTest CLI runs journeys, suites, browser sessions, auth, retries, and reports.
tags:
  - journeytest
  - cli
  - execution
timestamp: 2026-06-29T10:33:26Z
source_files:
  - README.md
  - src/cli.ts
  - src/runner/runJourney.ts
  - src/reporters/suiteDashboard.ts
  - src/reporters/runComparison.ts
---

# Running Journeys

Run a single journey with `journeytest run <journey-file> --profiles <profiles>
--provider <provider> --model <model>`. Run a suite by passing a directory of
journey JSON files. Directory runs recursively collect `*.json` files and group
all journey output under one timestamped run directory.

## Auth Resolution

Pi OAuth providers use an `auth.json` file. JourneyTest resolves it in this
order:

1. `--auth <path>`;
2. `JOURNEYTEST_AUTH_PATH`;
3. existing `./auth.json` in the current working directory;
4. the user config auth file.

The `journeytest auth` command prints where auth resolves from and which
providers are configured without printing secrets.

## Browser State and Environment

Use `--state <path>` to pass an `agent-browser` state file with cookies,
localStorage, and sessionStorage. Keep state files out of Git and prefer
short-lived test accounts.

Use `--viewport <width>x<height>[@scale]` for explicit dimensions or
`--device iphone-14`, `--device pixel-7`, or `--device ipad-pro-11` for curated
presets. CLI browser environment flags override journey defaults.

## Selection and Parallelism

Suite runs can filter by `--tag`, `--exclude-tag`, `--journey-id`,
`--exclude-journey-id`, `--rerun-failed`, and `--shard <index>/<total>`.

`--parallel-agents <count>` controls concurrency. With the default
`agent-browser` driver, `shared-tabs` mode runs parallel journeys in one browser
session with one labeled tab per journey. This shares cookies, storage, cache,
and history. `isolated-sessions` creates a separate browser session per journey.

## Retries and Timeouts

`--retries <count>` retries unhealthy journeys. The final `run.json` records
attempt metadata and marks journeys flaky when they pass after one or more
failed attempts.

Each director run has a wall-clock timeout. `--journey-timeout-ms <ms>` changes
the timeout, and `--journey-timeout-ms 0` disables it.

## Reports

Single journey runs print the dashboard path and `file://` URL. Directory runs
also write a suite dashboard and `history.json`. `--compare-to` compares a suite
against a previous suite directory or single `run.json`.

For CI, use `--junit`, `--github-annotations`, and `--summary-json`.
