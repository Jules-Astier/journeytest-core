---
name: journeytest-author
description: Create, review, and improve tester profiles and user journey definitions for @baguette-studios/journeytest-core AI-agent web app testing. Use when asked to generate JourneyTest JSON, standardize pass/fail/blocker criteria, write tester personas, design agent-directed browser test suites, or convert product requirements into JourneyTest user journeys.
---

# JourneyTest Author

Use this skill to write JourneyTest inputs that another AI agent can execute through `@baguette-studios/journeytest-core`.

## Workflow

1. Identify tester profiles first: role, permissions, perspective, goals, and constraints.
2. Split coverage into focused journeys. Prefer one meaningful user objective per journey.
3. Write journeys from the tester's point of view, not from DOM structure or implementation details.
4. Define explicit `passCriteria`, `failCriteria`, and optional `blockerCriteria`.
5. Make every criterion observable through browser state, app text, URL, screenshot, snapshot, or agent observation.
6. Add `requiredEvidence` for important criteria, especially final confirmations and blockers.
7. Use safe test data and include agent-facing labels or variables under `data`.
8. For journeys that require database state, add structured `dataLifecycle` for setup, preflight validation, post-run validation, and cleanup. Do not hide required fixture setup only in prose.
9. Keep human-readable service/auth assumptions in `preconditions`; keep the agent-executed browser path in `tasks`.
10. Make task instructions intent-rich enough that post-run bookmark curation can label UI actions as meaningful chapters.
11. When a task depends on a control that may have repeated labels, include stable UI landmarks in the task or task `data`: the screen, region, row/card/tree item, and visible post-click result. Do not use brittle snapshot refs, but do say enough for an agent to choose the right visible control.
12. For write actions, describe where the agent should look for downstream confirmation, not only the button's immediate response. Good confirmation surfaces include new or changed rows/cards, counters, status chips, activity feeds, timelines, assigned-item lists, destination views, modal state changes, and inline errors.

## Quality Bar

- Do not include CSS selectors, hardcoded snapshot refs, or brittle click paths.
- Do not rely on a generic button label when the UI has repeated labels. Say where the control is, such as "the Library tree row for the selected database" or "the Students table row for the invited student."
- If a target may be below the fold or inside a scrollable region, instruct the tester to scroll it into view before clicking and to verify the visible result after the click.
- For modal-heavy flows, describe the modal as its own interaction surface. Include the expected modal title, key fields, primary action, and post-submit result so the runner does not confuse modal controls with same-named controls behind the backdrop.
- If a write action may confirm outside the current viewport, instruct the tester to wait, take a fresh snapshot, and scroll the relevant page, modal, panel, list, activity feed, or destination view before deciding the app failed to confirm the action.
- Do not make a journey pass just because no error appeared.
- Do not omit fail criteria. Every journey needs concrete ways to fail.
- Use blocker criteria for missing auth, permissions, seed data, unavailable services, or app crashes that prevent evaluation. If the condition can be checked against a database, prefer a `dataLifecycle.preflight` operation plus a blocker criterion explaining the user-visible impact.
- Make criteria specific enough for the executing agent to justify a verdict.
- Prefer several small journeys over a single broad journey that tests too much.

## Data Lifecycle Guidance

- Use `dataLifecycle` when a journey needs seeded records, fixture validation, hard database postconditions, or per-run cleanup.
- Let the app own domain meaning through test-only backend functions. JourneyTest should call functions such as `testLifecycle:setupInvite`, `testLifecycle:assertInviteSent`, and `testLifecycle:cleanupJourney`, not describe raw table inserts.
- Put setup functions in `setup`, readiness checks in `preflight`, DB truth checks after the browser run in `postconditions`, and cleanup functions in `cleanup`.
- Use `manifestPath` when setup returns a large manifest and the journey needs only one slice.
- Use `$context.namespace`, `$context.runId`, `$manifest`, `$manifest.someField`, and `$suiteManifest.someField` in operation args instead of hardcoding generated IDs.
- Prefer per-run namespaces and cleanup handles for write journeys, especially when suites may run in parallel.
- Keep sensitive values out of journey JSON. Reference env vars through lifecycle config or operation args such as `$env.TEST_USER_PASSWORD`; lifecycle artifacts redact common secret-looking keys.
- If post-run database validation is required, make it a `postconditions` operation. Do not ask the browser agent to infer backend state that can be checked deterministically.
- If cleanup is necessary to keep fixtures reusable, include it explicitly. Mention `--keep-data` only as a debugging option, not as normal authoring guidance.

## References

- Read `references/schema.md` when writing JSON fields.
- Read `references/schema.md#data-lifecycle` when a journey needs database setup, hard data validation, or cleanup.
- Read `references/examples.md` when you need a concrete tester profile or journey example.
