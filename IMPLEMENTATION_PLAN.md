# @baguette-studios/journeytest-core Implementation Plan

## Goal

Create a TypeScript library and CLI for AI-agent-directed web app journey testing. The framework standardizes tester profiles, user journeys, evidence artifacts, event timelines, and reports. The agent determines the journey verdict against explicit pass, fail, and blocker criteria.

## Architecture

1. Core schemas and types
   - Define runtime-validated tester profile, user journey, criteria, evidence, timeline, finding, agent verdict, and run result schemas.
   - Export TypeScript types inferred from the schemas.
   - Keep run status separate from agent verdict status.

2. Browser driver boundary
   - Define a model-agnostic `BrowserDriver` interface.
   - Implement `AgentBrowserDriver` using the installed `agent-browser` CLI.
   - Enforce allowed origins before navigation.
   - Capture snapshots, screenshots, URL/title reads, waits, and video recording paths.

3. Agent director boundary
   - Define an `AgentDirector` interface.
   - Implement `PiSdkDirector` using `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`.
   - Expose browser tools to Pi through TypeBox tool schemas.
   - Require the agent to call `journey_finish` with a structured verdict.
   - Validate the verdict with JourneyTest schemas.

4. Runner and artifacts
   - Create one run directory per journey execution.
   - Write append-only `events.ndjson`.
   - Record video as `video.webm` when enabled.
   - Write canonical `run.json`, human `report.md`, and static `dashboard.html`.

5. CLI
   - `journeytest validate`: validate journey and profile files.
   - `journeytest run`: run a single journey file or recursively collect journey JSON files from a directory with Pi and agent-browser.
   - Keep flags explicit for model provider, model id, output directory, session name, state file, and video.
   - Print each run dashboard path and file URL. For directory runs, group journeys under one run folder and generate `dashboard.html` as the run-level entrypoint.
   - Support `--parallel-agents <count>` to run multiple collected journeys concurrently, with distinct browser sessions per parallel journey.

6. Reports
   - Generate Markdown report from the agent verdict and timeline.
   - Include linked artifacts and video timestamps when available.
   - Generate a static evidence dashboard with browser video playback, curated UI-action chapter bookmarks, moment context, verdict text, screenshots, snapshots, timeline, and raw run data.
   - Run an optional post-run Pi bookmark curator that can remove noisy UI action bookmarks or relabel them with chapter-style labels.
   - Optionally trim a leading solid-color video section, condense long identical-frame sections, and shift all recorded video timestamps by removed durations.
   - Show click markers on the dashboard video when browser action events include click coordinates.

7. Companion skill
   - Bundle `skills/journeytest-author`.
   - Instruct agents how to create high-quality tester profiles and user journeys.
   - Include schema and example references.

8. Tests
   - Validate example schemas.
   - Run the core runner with a fake browser driver and scripted director.
   - Verify artifacts and report output.

## Non-goals for v0

- A hosted SaaS runner.
- Automatic app crawling.
- Deterministic pass/fail reinterpretation by the framework.
- Secret management beyond safe path handling and documentation.
