# @baguette-studios/journeytest-core

AI-agent-directed user journey testing for web apps.

`@baguette-studios/journeytest-core` standardizes:

- tester profiles
- user journeys
- explicit pass, fail, and blocker criteria
- agent-owned verdicts
- video, timeline, JSON, screenshot, dashboard, and Markdown report artifacts

The first director implementation uses Pi Agent SDK. The first browser implementation uses the `agent-browser` CLI.

## Install

```bash
npm install @baguette-studios/journeytest-core
npm install agent-browser
```

JourneyTest runs on Node.js 24 or newer. The default browser driver shells out
to the `agent-browser` CLI, so install `agent-browser` in the project that runs
journeys or make the `agent-browser` executable available on `PATH`.

For local development:

```bash
npm install
npm run build
```

## Release Automation

Pushes to `main` run the CI/CD workflow. The `validate` job runs type checks,
tests, and `npm pack --dry-run`; if that passes, the `publish` job checks the
`package.json` version against npm and publishes only when that exact version is
not already present.

Publishing uses `npm publish --provenance --access public`. Configure npm
Trusted Publishing for `Jules-Astier/journeytest-core` and
`.github/workflows/ci.yml`, or add a GitHub Actions repository secret named
`NPM_TOKEN` with npm publish permission.

## Validate Examples

```bash
npx journeytest validate --journeys examples/journeys --profiles examples/profiles
```

## Author Journey JSON

These helper commands are deterministic local utilities. They do not call a model.

Create a starter authoring tree:

```bash
npx journeytest init --dir journeytest
```

This writes:

```text
journeytest/
  profiles/admin.json
  journeys/admin-invite-user.json
```

Generate one profile or journey at a time:

```bash
npx journeytest new profile admin --out journeytest/profiles/admin.json

npx journeytest new journey admin-invite-user \
  --profile admin \
  --app-name "Acme Admin" \
  --base-url http://127.0.0.1:3000 \
  --out journeytest/journeys/admin-invite-user.json
```

Draft a richer journey from structured local inputs without calling a model:

```bash
npx journeytest draft journey checkout-refund \
  --title "Checkout refund request" \
  --profile support \
  --app-name "Support Console" \
  --base-url http://127.0.0.1:5173 \
  --objective "Submit a refund request for a disposable order." \
  --precondition "The tester is authenticated as support." \
  --task "Find the disposable order." \
  --task-outcome "The order detail page is visible." \
  --task "Submit a refund request." \
  --pass "The app confirms that the refund request was submitted." \
  --fail "The app reports success but the order shows no refund request." \
  --blocker "Stop if the order is not disposable test data." \
  --data orderId=ord_test_123 \
  --out journeytest/journeys/checkout-refund.json
```

You can also supply `--input draft.json` with the same fields in JSON and override individual values with flags.

Print JSON Schema for editor integration or review:

```bash
npx journeytest schema journey > journey.schema.json
npx journeytest schema profile > profile.schema.json
npx journeytest schema --out journeytest.schemas.json
```

Lint journeys for schema validity and authoring quality:

```bash
npx journeytest lint --journeys journeytest/journeys --profiles journeytest/profiles
```

`lint` catches missing blocker criteria, weak or generic fail criteria, critical pass criteria without required evidence, and destructive journeys that lack explicit blocker or cleanup guidance.

## Run A Journey

```bash
npx journeytest run examples/journeys/admin-invite-user.json \
  --profile examples/profiles/admin.json \
  --provider anthropic \
  --model claude-sonnet-4-20250514 \
  --out runs
```

## Model Authentication

Pi OAuth providers such as `anthropic`, `openai-codex`, and `github-copilot` need an OAuth `auth.json` file. JourneyTest resolves that file in this order:

1. `--auth <path>`
2. `JOURNEYTEST_AUTH_PATH`
3. Existing `./auth.json` in the current working directory, for backward compatibility
4. User config auth file

The default user config path is:

- macOS: `~/Library/Application Support/JourneyTest/auth.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/journeytest/auth.json`
- Windows: `%APPDATA%\JourneyTest\auth.json`

The upstream Pi login CLI writes `auth.json` into its current directory. On macOS, create the default JourneyTest auth file with:

```bash
mkdir -p "$HOME/Library/Application Support/JourneyTest"
(cd "$HOME/Library/Application Support/JourneyTest" && npx @earendil-works/pi-ai login anthropic)
```

For a project-local legacy file, run `npx @earendil-works/pi-ai login anthropic` from the project root. `auth.json` is ignored by Git, but a user config location is preferred for new setup. To use another file:

```bash
npx journeytest run examples/journeys \
  --profiles examples/profiles \
  --provider anthropic \
  --model claude-sonnet-4-20250514 \
  --auth ~/.config/journeytest/auth.json
```

or:

```bash
JOURNEYTEST_AUTH_PATH=~/.config/journeytest/auth.json npx journeytest run examples/journeys \
  --profiles examples/profiles \
  --provider anthropic \
  --model claude-sonnet-4-20250514
```

Inspect the auth file JourneyTest will use without printing secrets:

```bash
npx journeytest auth
npx journeytest auth --json
```

JourneyTest does not maintain its own fixed provider/model list. For the Pi
director and bookmark curator, `--provider` and `--model` are passed through to
the installed Pi package. Any provider/model pair supported by that Pi version
can be used. OAuth-backed providers must have credentials in the resolved
`auth.json`; API-key-backed providers can use the environment variables or auth
mechanisms expected by Pi.

## Browser State Setup

Use `--state <path>` when the tested app needs pre-authenticated browser cookies or storage:

```bash
agent-browser open http://127.0.0.1:3000
# Log in manually or with agent-browser commands, then save state:
agent-browser state save ./auth-state.json

npx journeytest run examples/journeys/admin-invite-user.json \
  --profile examples/profiles/admin.json \
  --provider anthropic \
  --model claude-sonnet-4-20250514 \
  --state ./auth-state.json \
  --out runs
```

Browser state files contain cookies, localStorage, and sessionStorage. Keep them out of Git; `auth-state*.json`, `browser-state*.json`, `storage-state*.json`, and `*.storage-state.json` are ignored by default. For long-lived shared state, prefer a path outside the repo and pass it with `--state`.

## Browser Environment

Set browser environment overrides per run:

```bash
npx journeytest run examples/journeys/admin-invite-user.json \
  --profile examples/profiles/admin.json \
  --provider anthropic \
  --model claude-sonnet-4-20250514 \
  --viewport 1440x900@2 \
  --out runs
```

or use a curated device preset:

```bash
npx journeytest run examples/journeys/admin-invite-user.json \
  --profile examples/profiles/admin.json \
  --provider anthropic \
  --model claude-sonnet-4-20250514 \
  --device iphone-14 \
  --out runs
```

Journeys can also declare `browserEnvironment` defaults in JSON. CLI flags override journey defaults. Current built-in presets are `iphone-14`, `pixel-7`, and `ipad-pro-11`.

## Secret Handling

JourneyTest redacts common secret-shaped values before writing text artifacts and event/result JSON: API keys, OAuth/access/refresh tokens, bearer/basic authorization headers, cookies, browser storage state, password/secret-looking keys, and values supplied by lifecycle providers through `redactValues`. This applies to `events.ndjson`, `run.json`, Markdown/dashboard rendering, browser snapshots, visible-DOM summaries, UI-change timeline JSON, console evidence, network request logs, HAR files, and lifecycle artifacts.

Screenshots and video are visual evidence and cannot be text-redacted. Avoid displaying raw secrets in the app under test, and use dedicated test accounts and short-lived browser state.

## Run A Directory Of Journeys

`run` also accepts a directory and recursively discovers `*.json` journey files, similar to pytest collection:

```bash
npx journeytest run examples/journeys \
  --profiles examples/profiles \
  --provider anthropic \
  --model claude-sonnet-4-20250514 \
  --out runs
```

Filter suites with tags, journey ids, deterministic shards, or rerun-failed selection:

```bash
npx journeytest run examples/journeys \
  --profiles examples/profiles \
  --provider anthropic \
  --model claude-sonnet-4-20250514 \
  --tag smoke \
  --exclude-tag destructive \
  --journey-id admin-invite-user \
  --shard 1/3 \
  --out runs
```

Rerun only unhealthy journeys from a previous suite directory, `history.json`, or `run.json`:

```bash
npx journeytest run examples/journeys \
  --profiles examples/profiles \
  --provider anthropic \
  --model claude-sonnet-4-20250514 \
  --rerun-failed runs/<previous-timestamp>-run \
  --out runs
```

By default, journeys run sequentially. Run multiple journeys at once with `--parallel-agents`:

```bash
npx journeytest run examples/journeys \
  --profiles examples/profiles \
  --provider anthropic \
  --model claude-sonnet-4-20250514 \
  --parallel-agents 3 \
  --out runs
```

With the default `agent-browser` driver, parallel journeys share one headless browser session and each journey gets its own labeled tab. This keeps parallel runs from launching one Chrome-for-Testing app per agent. Browser commands are safely serialized around tab switching, while Pi directors can still run concurrently.

Tabs in a shared browser session share cookies, storage, cache, and history. `agent-browser` also supports one active video recording per session, so JourneyTest records short action clips by default and stitches them into the dashboard video after the run. This keeps shared-tab video serialization limited to the brief windows around clicks, fills, typing, key presses, hovers, drags, and uploads. For full browser-session isolation, or fully concurrent per-journey video recording, use:

```bash
npx journeytest run examples/journeys \
  --profiles examples/profiles \
  --provider anthropic \
  --model claude-sonnet-4-20250514 \
  --parallel-agents 3 \
  --parallel-browser-mode isolated-sessions \
  --out runs
```

In isolated-session mode, each journey gets its own Pi director, browser driver, run directory, and browser session. If you do not pass `--session`, JourneyTest uses the generated run id as the session name. If you pass `--session` with `--parallel-agents > 1`, the value is treated as a session prefix and each journey receives a unique derived browser session name.

JourneyTest records only the short evidence windows around browser actions, then stitches those clips into `video.webm` so dashboard bookmarks still seek through one condensed video. Use `--no-video` to skip video entirely.

Use `--retries <count>` to retry failing journeys. The final `run.json` keeps per-attempt metadata and marks journeys as flaky when they pass only after one or more failed attempts.

Each journey director run has a wall-clock timeout. The default is 30 minutes per attempt; tune it with `--journey-timeout-ms <ms>`, or pass `--journey-timeout-ms 0` to disable it for an intentionally open-ended diagnostic run.

For a single journey, the CLI prints that run's `dashboard.html` path and `file://` URL. For multiple journeys, it prints every run dashboard plus a generated suite dashboard:

```text
Dashboard: /path/to/runs/<timestamp>-admin-invite-user/dashboard.html
Dashboard URL: file:///path/to/runs/<timestamp>-admin-invite-user/dashboard.html
Run dashboard: /path/to/runs/<timestamp>-run/dashboard.html
Run dashboard URL: file:///path/to/runs/<timestamp>-run/dashboard.html
```

For directory runs, all journey artifacts are grouped under that same run folder:

```text
runs/<timestamp>-run/
  dashboard.html
  history.json
  <timestamp>-journey-a/
  <timestamp>-journey-b/
```

Compare a suite run against a previous suite directory, or a single previous `run.json`, with `--compare-to`:

```bash
npx journeytest run examples/journeys \
  --profiles examples/profiles \
  --provider anthropic \
  --model claude-sonnet-4-20250514 \
  --compare-to runs/<previous-timestamp>-run \
  --out runs
```

The suite dashboard shows current and previous run/verdict status side by side, highlights newly failed, newly passed, still failing, and flaky/changed journeys, and writes a compact `history.json` summary for trend tooling.

The run writes:

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

Open `dashboard.html` in a browser to review the run video, timestamped bookmarks, agent verdict text, criteria, findings, screenshots, snapshots, UI-change timelines, raw JSON, and generated collateral links.

When click coordinates are available from the browser driver, the dashboard shows a brief marker over the video at the clicked point while playback reaches that action or when you click the corresponding chapter.

By default, JourneyTest records short UI-change timelines around click, fill, type, and key-press actions when the browser driver supports it. These artifacts capture visible user-relevant changes such as button label changes, status/alert/live-region updates, dialogs, route changes, focus changes, and form progress. Change timelines are written under `ui-changes/`, with supporting before/change/after screenshots in `screenshots/`, before/after accessibility snapshots in `snapshots/`, and bounded before/after visible-DOM summaries when supported by the browser driver. Journeys can require this evidence with `requiredEvidence: ["uiChangeTimeline"]`, and verdicts can attach the artifact path as `evidence.uiChangeTimeline`.

Tune this capture with `--ui-change-timeout-ms`, `--ui-change-quiet-ms`, `--ui-change-max-changes`, `--ui-change-max-screenshots`, `--no-ui-change-screenshots`, `--no-ui-change-snapshots`, and `--no-ui-change-dom-snapshots`. Disable the observation window entirely with `--no-ui-change-recording`.

The browser tool surface also supports targeted container scrolling, hover, drag-and-drop, and file upload when the active driver supports them. For scrolling, pass a target container selector/ref to scroll within a modal or panel instead of the page.

## Video Chapters

Recorded videos get timestamped bookmarks from UI actions only, such as clicks, fills, typing, pressing keys, drags, uploads, and hovers. Snapshot captures, screenshots, tool start/end events, and assistant-message events are not turned into bookmarks. In action-clip mode, bookmark timestamps refer to the stitched condensed video rather than the original wall-clock journey time.

By default, the CLI runs a post-run Pi bookmark curator using the same `--provider` and `--model`. The curator receives the action timeline plus nearby assistant text and can remove noisy action bookmarks or relabel them as concise chapter-style labels such as `Submit invite form`.

Disable that extra model call with:

```bash
npx journeytest run examples/journeys \
  --profiles examples/profiles \
  --provider anthropic \
  --model claude-sonnet-4-20250514 \
  --no-curate-bookmarks
```

Use a custom bookmark-curation system prompt with `--bookmark-system-prompt ./prompt.txt`.

## Data Lifecycle

Journeys can declare database setup, preflight checks, post-run checks, and cleanup separately from the loose `data` bag. JourneyTest orchestrates the lifecycle and writes durable artifacts:

```text
runs/<timestamp>-<journey-id>/
  setup.json
  preflight.json
  postconditions.json
  cleanup.json
```

Define named environments in a lifecycle config file and pass it to `run`. Environments can use Convex functions, local scripts, or app-owned HTTP endpoints:

```json
{
  "appLifecycle": {
    "ports": {
      "frontend": {},
      "backend": {}
    },
    "app": {
      "baseUrl": "http://$hosts.frontend:$ports.frontend",
      "allowedOrigins": [
        "http://$hosts.frontend:$ports.frontend",
        "http://$hosts.backend:$ports.backend"
      ]
    },
    "start": {
      "command": "node",
      "commandArgs": ["scripts/journeytest-services.mjs", "start"],
      "env": {
        "FRONTEND_PORT": "$ports.frontend",
        "BACKEND_PORT": "$ports.backend"
      },
      "passContext": "json-stdin",
      "cwd": "../my-app",
      "timeoutMs": 60000
    },
    "cleanup": {
      "command": "node",
      "commandArgs": ["scripts/journeytest-services.mjs", "cleanup"],
      "passContext": "json-stdin",
      "cwd": "../my-app"
    }
  },
  "dataEnvironments": {
    "local-convex": {
      "provider": "convex",
      "transport": "http",
      "urlEnv": "CONVEX_URL",
      "capabilities": {
        "publicFunctions": true,
        "internalFunctions": false
      }
    },
    "local-script": {
      "provider": "script",
      "command": "node",
      "commandArgs": ["scripts/journeytest-lifecycle.mjs"],
      "passArgs": "json-argv",
      "cwd": "../my-app"
    },
    "local-http": {
      "provider": "http",
      "url": "http://127.0.0.1:3000/__journeytest/lifecycle",
      "authHeader": "X-JourneyTest-Token",
      "authTokenEnv": "JOURNEYTEST_LIFECYCLE_TOKEN"
    }
  }
}
```

```bash
npx journeytest run examples/journeys \
  --profiles examples/profiles \
  --provider anthropic \
  --model claude-sonnet-4-20250514 \
  --data-lifecycle journeytest.lifecycle.json \
  --out runs
```

The CLI default data lifecycle provider auto-routes each environment by its `provider` field. Use `--data-lifecycle-provider convex`, `script`, or `http` only when you intentionally want to force one provider factory.

`appLifecycle` is for the app-under-test services: Docker compose stacks, frontend/backend dev servers, workers, or similar. JourneyTest allocates unused ports for each name in `ports`, expands `$ports.<name>` and `$hosts.<name>` in `app`, `commandArgs`, and `env`, then runs `start` before suite data lifecycle and journeys. If `app.baseUrl` is set, selected journeys run against that resolved URL instead of the URL authored in each journey file.

Start and cleanup scripts receive a JSON context by argv, stdin, or not at all:

```json
{
  "phase": "start",
  "suiteRunId": "2026-06-28T210000-run",
  "runDir": "runs/2026-06-28T210000-run/_app-lifecycle",
  "ports": { "frontend": 51749, "backend": 51750 },
  "hosts": { "frontend": "127.0.0.1", "backend": "127.0.0.1" },
  "app": { "baseUrl": "http://127.0.0.1:51749" }
}
```

The start script should launch or reuse services, wait until they are healthy, then exit. The cleanup script runs after suite cleanup, and JourneyTest also attempts it on `SIGINT` or `SIGTERM`. Script stdout, stderr, exit code, parsed JSON output, and cleanup results are written under `_app-lifecycle/`.

Each journey can reference an environment and app-owned lifecycle operations:

```json
{
  "dataLifecycle": {
    "environment": "local-convex",
    "setup": {
      "id": "setup-s2",
      "kind": "mutation",
      "function": "testLifecycle:setupS2",
      "manifestPath": "$.journeys.s2"
    },
    "preflight": [
      {
        "id": "s2-ready",
        "kind": "query",
        "function": "testLifecycle:assertS2Ready"
      }
    ],
    "postconditions": [
      {
        "id": "s2-submitted",
        "kind": "query",
        "function": "testLifecycle:assertS2Submitted"
      }
    ],
    "cleanup": {
      "id": "cleanup-s2",
      "kind": "mutation",
      "function": "testLifecycle:cleanupJourney",
      "args": { "namespace": "$context.namespace" }
    }
  }
}
```

The same `dataLifecycle` operation shape works for every provider. `args` supports `$context.scope`, `$context.runId`, `$context.suiteRunId`, `$context.journeyRunId`, `$context.journeyId`, `$context.testerProfileId`, `$context.namespace`, `$context.environment`, `$manifest`, `$manifest.field`, `$suiteManifest`, `$suiteManifest.field`, and `$env.NAME`.

For `script` environments, `function` is the operation name passed to the configured command. By default JourneyTest runs:

```text
<command> <commandArgs...> <function> '<resolved args JSON>'
```

If `command` is omitted, `function` is executed as the command and the resolved args JSON is passed as the first argv value. Set `passArgs` to `json-stdin` to write JSON to stdin or `none` to pass no operation args. Script stdout, stderr, and exit code are captured in lifecycle artifacts. The last JSON line printed to stdout is used as the operation result, which can include `checks`.

For `http` environments, `function` is an endpoint path under `url` unless it is absolute. JourneyTest posts the resolved args JSON to that endpoint and uses the JSON response as the operation result. If `authTokenEnv` is set, JourneyTest sends `Authorization: Bearer <token>` by default; use `authHeader` and `authScheme` to customize it. Auth token values are redacted from lifecycle artifacts, including echoed response fields and error text.

Use `--keep-data` to skip cleanup while debugging. Convex HTTP transport requires the app project to expose test-gated public functions. Convex CLI transport uses `npx convex run` from `projectDir` and can target internal functions when the environment declares that capability.

## Action Clip Video

When video recording is enabled, JourneyTest records around browser actions such as clicks, fills, typing, key presses, hovers, drags, and uploads. Each action clip is saved under `video-clips/`, then the clips are stitched into `video.webm` when `ffmpeg` is available. The dashboard uses the stitched video, so action bookmarks seek to the relevant condensed timestamp without preserving model-thinking dead air.

## Verdict Ownership

The framework owns schema validation, browser action execution, artifact capture, and report writing.

The agent owns the test verdict. A journey must include explicit `passCriteria`, `failCriteria`, and optional `blockerCriteria`. The Pi director requires the agent to call `journey_finish` with a structured verdict, which the framework validates and records.
