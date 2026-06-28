# JourneyTest Schema Reference

## Tester Profile

```json
{
  "id": "admin",
  "name": "Workspace Admin",
  "role": "Admin",
  "perspective": "Manage users, settings, and operational workflows.",
  "permissions": ["Can invite teammates"],
  "goals": ["Complete admin tasks efficiently"],
  "constraints": ["Use only normal in-app UI"]
}
```

Required fields: `id`, `name`, `role`, `perspective`.

Optional fields: `permissions`, `goals`, `constraints`, `notes`.

## User Journey

```json
{
  "id": "admin-invite-user",
  "title": "Admin invites a teammate",
  "app": {
    "name": "Acme Admin",
    "baseUrl": "http://127.0.0.1:3000",
    "allowedOrigins": ["http://127.0.0.1:3000"]
  },
  "testerProfile": "admin",
  "objective": "Invite a new teammate as a workspace admin.",
  "preconditions": ["The tester is authenticated as an admin."],
  "data": {
    "email": "test+invite@example.com",
    "role": "Member"
  },
  "tasks": [
    {
      "id": "find-user-management",
      "instruction": "Find where admins manage users or teammates."
    }
  ],
  "passCriteria": [
    {
      "id": "invite-confirmed",
      "statement": "The app clearly confirms that the invitation was sent to the specified email address.",
      "requiredEvidence": ["videoTimestamp", "screenshot", "agentObservation"]
    }
  ],
  "failCriteria": [
    {
      "id": "invite-not-confirmed",
      "statement": "The tester submits the invite but the app does not clearly confirm that it was sent."
    }
  ],
  "blockerCriteria": [
    {
      "id": "auth-blocked",
      "statement": "The tester cannot access the admin area because authentication or permissions block the journey."
    }
  ],
  "riskLevel": "writes-test-data"
}
```

Required fields: `id`, `title`, `app`, `testerProfile`, `objective`, `tasks`, `passCriteria`, `failCriteria`.

Optional fields: `preconditions`, `data`, `blockerCriteria`, `evidenceRequirements`, `riskLevel`.

## Data Lifecycle

Use `dataLifecycle` when the journey needs app-owned seed data, hard database validation, or cleanup. Keep user-facing labels and values in `data`; keep database lifecycle semantics in `dataLifecycle`.

Journey-level shape:

```json
{
  "dataLifecycle": {
    "environment": "local-convex",
    "setup": {
      "id": "setup-invite",
      "kind": "mutation",
      "function": "testLifecycle:setupInviteJourney",
      "args": {
        "namespace": "$context.namespace"
      },
      "manifestPath": "$.journeys.invite"
    },
    "preflight": [
      {
        "id": "invite-ready",
        "kind": "query",
        "function": "testLifecycle:assertInviteReady",
        "args": {
          "manifest": "$manifest"
        }
      }
    ],
    "postconditions": [
      {
        "id": "invite-created",
        "kind": "query",
        "function": "testLifecycle:assertInviteCreated",
        "args": {
          "namespace": "$context.namespace",
          "email": "$manifest.email"
        }
      }
    ],
    "cleanup": {
      "id": "cleanup-invite",
      "kind": "mutation",
      "function": "testLifecycle:cleanupJourney",
      "args": {
        "namespace": "$context.namespace"
      }
    }
  }
}
```

Lifecycle operation fields:

- `id`: stable operation id.
- `kind`: `query`, `mutation`, or `action`. Defaults to `mutation`.
- `function`: app-owned operation name. For Convex this is a function path, for script this is the operation name or command, and for HTTP this is an endpoint path under the environment URL.
- `args`: JSON args. Supports `$context.scope`, `$context.runId`, `$context.suiteRunId`, `$context.journeyRunId`, `$context.journeyId`, `$context.testerProfileId`, `$context.namespace`, `$context.environment`, `$manifest`, `$manifest.field`, `$suiteManifest`, `$suiteManifest.field`, and `$env.NAME`.
- `manifestPath`: optional JSON path selecting the setup result slice saved as the journey manifest.
- `requiredCapabilities`: optional capabilities such as `internalFunctions`.
- `allowFailure`: optional boolean for non-blocking checks.
- `redactKeys`: extra keys to redact from lifecycle artifacts.

Lifecycle operation results can include checks:

```json
{
  "checks": [
    {
      "id": "invite-exists",
      "status": "pass",
      "message": "The seeded invite exists."
    }
  ]
}
```

A `fail` check in `setup` or `preflight` blocks the browser run. A `fail` check in `postconditions` fails the framework-owned data lifecycle result even if the agent verdict passed.

Lifecycle config file shape, passed with `--data-lifecycle`:

```json
{
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

Convex environment fields:

- `provider`: `convex`.
- `transport`: `http` for public/test-token-gated functions, or `cli` for `npx convex run`.
- `url` or `urlEnv`: required for HTTP transport.
- `authTokenEnv`: optional token env var for HTTP transport.
- `projectDir`: optional app directory for CLI transport.
- `deployment`: optional Convex deployment reference, such as `local`, `dev`, or `prod`.
- `prod`: optional boolean to add `--prod` for CLI transport.
- `push`: optional boolean to add `--push` for CLI transport.
- `capabilities`: declare whether the environment supports `publicFunctions` or `internalFunctions`.

Script environment fields:

- `provider`: `script`.
- `command`: optional command to execute. If omitted, each operation's `function` is executed as the command.
- `commandArgs`: optional static argv values before the operation name.
- `cwd`: optional working directory.
- `env`: optional string environment variable overrides for the child process.
- `passArgs`: `json-argv` by default, or `json-stdin` / `none`.
- `timeoutMs`: optional process timeout.
- `capabilities`: declare whether the environment supports `publicFunctions` or `internalFunctions`.

Script execution captures stdout, stderr, and exit code. Print a JSON result as the full stdout or the last stdout line when setup manifests or checks are needed.

HTTP environment fields:

- `provider`: `http`.
- `url` or `urlEnv`: base URL for app-owned lifecycle endpoints.
- `headers`: optional static request headers.
- `authHeader`: optional auth header name. Defaults to `Authorization`.
- `authScheme`: optional auth scheme. Defaults to `Bearer`; set to an empty string for a raw token.
- `authTokenEnv`: optional env var containing an auth token.
- `timeoutMs`: optional request timeout.
- `capabilities`: declare whether the environment supports `publicFunctions` or `internalFunctions`.

HTTP execution posts resolved operation `args` as JSON to `<url>/<function>` unless `function` is an absolute URL or starts with `/`. Token values from `authTokenEnv` are redacted from args, results, manifests, stdout/stderr, and error text if echoed by the app.

Suite-level lifecycle is configured in the same config file with `suiteLifecycle`. Use it for shared expensive fixtures that return a manifest consumed by journeys through `$suiteManifest`.

## Criterion Rules

Criteria use this shape:

```json
{
  "id": "criterion-id",
  "statement": "Observable condition the agent can evaluate.",
  "requiredEvidence": ["videoTimestamp", "screenshot"],
  "severity": "major"
}
```

Allowed evidence kinds:

- `videoTimestamp`
- `screenshot`
- `snapshot`
- `url`
- `agentObservation`
- `console`
- `network`
- `uiChangeTimeline`

Allowed severities:

- `info`
- `minor`
- `major`
- `critical`

## Writing Good Criteria

Good:

- "The app clearly confirms that the invitation was sent to the specified email address."
- "The tester can recover from a validation error without losing entered form data."
- "A non-admin control is unavailable or clearly permission-gated for this tester profile."
- "After publishing, the updated item is visible in the relevant list, status chip, detail pane, activity feed, or subscriber view after the tester refreshes the snapshot and scrolls the relevant container."

Bad:

- "Click the blue button."
- "The test passes."
- "No bugs happen."
- "The DOM contains `.success-toast`."
- "The tester clicked Save, so the change happened."

## Risk Levels

- `read-only`: The journey should not create, update, or delete app data.
- `writes-test-data`: The journey creates or updates disposable test data.
- `destructive`: The journey deletes or modifies meaningful data. Use only when explicitly requested.
