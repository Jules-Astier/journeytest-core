---
okf_version: "0.1"
---

# JourneyTest Docs

This is the OKF documentation bundle for `@baguette-studios/journeytest-core`.
It explains the product model, current feature surface, and implementation
boundaries that should stay current as the package evolves.

## Map

- [Product](product/index.md): What JourneyTest is and which features it
  exposes.
- [Architecture](architecture/index.md): How journeys move through schemas,
  runners, directors, drivers, reporters, and lifecycle providers.
- [Authoring](authoring/index.md): How tester profiles and journey JSON are
  shaped.
- [Running](running/index.md): How CLI execution, parallelism, retries,
  browser state, and authentication work.
- [Lifecycle](lifecycle/index.md): How app and data lifecycle hooks prepare,
  verify, and clean up test data.
- [Reference](reference/index.md): Durable artifact, evidence, and release
  automation references.
- [Documentation log](log.md): Chronological notes for documentation updates.

## Maintenance Rule

Any code change that affects public behavior, generated artifacts, configuration,
or extension points must update the relevant docs in this bundle before the
change is considered complete.
