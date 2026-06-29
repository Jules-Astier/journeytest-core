---
type: Lifecycle Guide
title: App and Data Lifecycle
description: Explains lifecycle configuration for app startup, suite setup, journey setup, checks, and cleanup.
tags:
  - journeytest
  - lifecycle
  - data
timestamp: 2026-06-29T10:33:26Z
source_files:
  - README.md
  - src/core/schemas.ts
  - src/lifecycle/appServices.ts
  - src/lifecycle/convex.ts
  - src/lifecycle/http.ts
  - src/lifecycle/router.ts
  - src/lifecycle/script.ts
  - src/lifecycle/types.ts
---

# App and Data Lifecycle

Lifecycle support keeps test data and app-under-test startup separate from the
journey's loose `data` bag.

## App Lifecycle

`appLifecycle` starts and cleans up the app under test for a suite. It can
allocate named local ports, expand `$ports.<name>` and `$hosts.<name>`, run a
start command, wait for that command to finish successfully, and override the
journey app target with the resolved `app.baseUrl`.

App lifecycle artifacts are written under `_app-lifecycle/`. The cleanup command
runs after suite data lifecycle and also on `SIGINT` or `SIGTERM` where
possible.

## Suite Lifecycle

`suiteLifecycle` prepares shared data around all selected journeys. It supports
setup, preflight, postconditions, and cleanup. If setup or preflight blocks the
suite, selected journeys are not run.

Suite lifecycle artifacts are written under `_suite-lifecycle/`.

## Journey Lifecycle

A journey can declare `dataLifecycle` with an environment and operations for:

- `setup`: create or seed data before browser execution;
- `preflight`: verify the environment is ready before browser execution;
- `postconditions`: verify expected data state after the journey;
- `cleanup`: remove or reset data after the journey.

Lifecycle operation args can reference context values such as run ids, journey
ids, tester profile ids, namespaces, manifests, suite manifests, and environment
variables.

## Providers

The default provider router selects a provider by each environment's `provider`
field. Built-in providers are:

- `convex`: runs Convex functions through HTTP or CLI transport;
- `script`: runs local commands and passes resolved args through argv, stdin, or
  not at all;
- `http`: posts resolved args JSON to app-owned HTTP endpoints.

Use `--data-lifecycle-provider` only when intentionally forcing one provider
factory. Use `--keep-data` to skip cleanup while debugging.

## Redaction

Lifecycle provider outputs are artifacts, so they pass through secret redaction.
Auth token values, echoed secrets, and error text are redacted in text outputs.
