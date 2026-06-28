# JourneyTest Examples

## Admin Profile

```json
{
  "id": "admin",
  "name": "Workspace Admin",
  "role": "Admin",
  "perspective": "Responsible for managing workspace users, permissions, and operational setup.",
  "permissions": [
    "Can access admin settings",
    "Can invite users",
    "Can change teammate roles"
  ],
  "goals": [
    "Complete admin tasks without needing developer knowledge",
    "Understand whether actions succeeded"
  ],
  "constraints": [
    "Use only normal in-app UI",
    "Do not use browser devtools or backend dashboards"
  ]
}
```

## Read-Only Dashboard Journey

```json
{
  "id": "admin-review-dashboard-health",
  "title": "Admin reviews dashboard health",
  "app": {
    "name": "Acme Admin",
    "baseUrl": "http://127.0.0.1:3000",
    "allowedOrigins": ["http://127.0.0.1:3000"]
  },
  "testerProfile": "admin",
  "objective": "Review whether the dashboard communicates current workspace health.",
  "preconditions": [
    "The tester is authenticated as an admin.",
    "The workspace has representative seeded data."
  ],
  "tasks": [
    {
      "id": "open-dashboard",
      "instruction": "Open the main dashboard."
    },
    {
      "id": "interpret-health",
      "instruction": "Determine whether the dashboard clearly communicates current workspace health and any issues needing attention."
    }
  ],
  "passCriteria": [
    {
      "id": "health-visible",
      "statement": "The dashboard presents current workspace health or status in language the admin can understand.",
      "requiredEvidence": ["screenshot", "agentObservation"]
    }
  ],
  "failCriteria": [
    {
      "id": "health-ambiguous",
      "statement": "The dashboard has metrics but the tester cannot determine whether the workspace is healthy or needs attention."
    }
  ],
  "blockerCriteria": [
    {
      "id": "dashboard-unavailable",
      "statement": "The dashboard cannot be loaded or the tester is blocked before seeing dashboard content."
    }
  ],
  "riskLevel": "read-only"
}
```

## Journey Set Guidance

For a small app, start with 5-8 journeys:

- unauthenticated landing or login
- primary happy path
- primary validation/error path
- admin or settings path
- search/filter/discovery path
- read-only reporting path
- permission-gated path
- recovery path after interruption or failed input

## Convex-Seeded Write Journey

Use this pattern when the app owns Convex functions that create coherent domain fixtures and verify database truth after the UI run.

Lifecycle config:

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
    }
  }
}
```

Journey excerpt:

```json
{
  "id": "student-complete-intake",
  "title": "Student completes assigned intake",
  "app": {
    "name": "PlanPlan",
    "baseUrl": "http://localhost:8081",
    "allowedOrigins": ["http://localhost:8081"]
  },
  "testerProfile": "student",
  "objective": "Complete an assigned intake and submit it for coach review.",
  "preconditions": [
    "The local web app is running.",
    "The tester can authenticate as the seeded student account returned by lifecycle setup."
  ],
  "data": {
    "fixture": "pending intake student",
    "units": "metric"
  },
  "dataLifecycle": {
    "environment": "local-convex",
    "setup": {
      "id": "setup-intake",
      "kind": "mutation",
      "function": "testLifecycle:setupIntakeJourney",
      "args": {
        "namespace": "$context.namespace"
      },
      "manifestPath": "$.journeys.intake"
    },
    "preflight": [
      {
        "id": "intake-ready",
        "kind": "query",
        "function": "testLifecycle:assertIntakeReady",
        "args": {
          "manifest": "$manifest"
        }
      }
    ],
    "postconditions": [
      {
        "id": "intake-submitted",
        "kind": "query",
        "function": "testLifecycle:assertIntakeSubmitted",
        "args": {
          "studentId": "$manifest.studentId",
          "assignmentId": "$manifest.assignmentId"
        }
      }
    ],
    "cleanup": {
      "id": "cleanup-intake",
      "kind": "mutation",
      "function": "testLifecycle:cleanupJourney",
      "args": {
        "namespace": "$context.namespace"
      }
    }
  },
  "tasks": [
    {
      "id": "open-intake",
      "instruction": "Sign in as the seeded student account from the lifecycle manifest, then open the assigned intake."
    },
    {
      "id": "answer-required-questions",
      "instruction": "Answer all required intake questions, scrolling each question into view before interacting with it."
    },
    {
      "id": "submit-intake",
      "instruction": "Submit the intake, then take a fresh snapshot and inspect the page, student start page, or task list for submitted or review-pending state."
    }
  ],
  "passCriteria": [
    {
      "id": "submitted-confirmed",
      "statement": "The app visibly confirms that the intake was submitted or is pending coach review.",
      "requiredEvidence": ["screenshot", "agentObservation"],
      "severity": "critical"
    }
  ],
  "failCriteria": [
    {
      "id": "submission-not-confirmed",
      "statement": "The tester submits the intake but cannot find visible submitted, completed, or review-pending state after refreshing the snapshot and checking relevant pages.",
      "severity": "critical"
    }
  ],
  "blockerCriteria": [
    {
      "id": "required-seed-data-missing",
      "statement": "The assigned intake or seeded student account is unavailable before the browser journey can be evaluated.",
      "severity": "critical"
    }
  ],
  "riskLevel": "writes-test-data"
}
```

Authoring notes:

- Use `preflight` when missing or stale fixtures should block browser execution.
- Use `postconditions` when database truth matters beyond what the UI can prove.
- Use `cleanup` for every write journey unless the fixture is intentionally persistent.
- Keep implementation details inside app-owned lifecycle functions; the journey should express which state is required, not how tables are mutated.

## Script-Backed Lifecycle

Use this pattern when the app exposes local lifecycle commands instead of Convex functions.

Lifecycle config:

```json
{
  "dataEnvironments": {
    "local-script": {
      "provider": "script",
      "command": "node",
      "commandArgs": ["scripts/journeytest-lifecycle.mjs"],
      "cwd": "../my-app",
      "passArgs": "json-argv"
    }
  }
}
```

Journey excerpt:

```json
{
  "dataLifecycle": {
    "environment": "local-script",
    "setup": {
      "id": "setup-invite",
      "function": "setupInviteJourney",
      "args": {
        "namespace": "$context.namespace",
        "email": "test+invite@example.com"
      },
      "manifestPath": "$.invite"
    },
    "preflight": [
      {
        "id": "invite-ready",
        "kind": "query",
        "function": "assertInviteReady",
        "args": {
          "inviteId": "$manifest.inviteId"
        }
      }
    ],
    "cleanup": {
      "id": "cleanup-invite",
      "function": "cleanupJourney",
      "args": {
        "namespace": "$context.namespace"
      }
    }
  }
}
```

With the default `json-argv` mode, JourneyTest runs the configured command with the operation name followed by resolved args JSON. The script should print JSON to stdout when the operation needs to return a manifest or checks; stdout, stderr, and exit code are captured in lifecycle artifacts.

## HTTP Lifecycle Endpoint

Use this pattern when the app owns test-gated lifecycle endpoints.

Lifecycle config:

```json
{
  "dataEnvironments": {
    "local-http": {
      "provider": "http",
      "url": "http://127.0.0.1:3000/__journeytest/lifecycle",
      "authHeader": "X-JourneyTest-Token",
      "authTokenEnv": "JOURNEYTEST_LIFECYCLE_TOKEN"
    }
  }
}
```

Journey excerpt:

```json
{
  "dataLifecycle": {
    "environment": "local-http",
    "setup": {
      "id": "setup-project",
      "function": "setup-project",
      "args": {
        "namespace": "$context.namespace"
      },
      "manifestPath": "$.project"
    },
    "postconditions": [
      {
        "id": "project-updated",
        "kind": "query",
        "function": "assert-project-updated",
        "args": {
          "projectId": "$manifest.projectId"
        }
      }
    ],
    "cleanup": {
      "id": "cleanup-project",
      "function": "cleanup-project",
      "args": {
        "namespace": "$context.namespace"
      }
    }
  }
}
```

JourneyTest posts resolved args JSON to `/__journeytest/lifecycle/<function>`. If the endpoint echoes the configured auth token, JourneyTest redacts it from stored lifecycle artifacts.
