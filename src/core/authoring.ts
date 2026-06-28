import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  DataLifecycleConfigSchema,
  EvidenceKindSchema,
  JourneyCriterionSchema,
  JourneyTaskSchema,
  TesterProfileSchema,
  UserJourneySchema,
  type EvidenceKind,
  type JourneyCriterion,
  type JourneyTask,
  type TesterProfile,
  type UserJourney,
} from "./schemas.js";
import { validateAllowedOrigins, validateJourneyProfileMatch } from "./validation.js";

export const defaultAuthoringDir = "journeytest";

export interface TesterProfileTemplateOptions {
  id?: string;
  name?: string;
  role?: string;
  perspective?: string;
}

export interface UserJourneyTemplateOptions {
  id?: string;
  title?: string;
  appName?: string;
  baseUrl?: string;
  testerProfile?: string;
  riskLevel?: UserJourney["riskLevel"];
}

const DraftJourneyTaskInputSchema = z.union([
  z.string().min(1),
  JourneyTaskSchema.partial({ id: true }).extend({
    instruction: z.string().min(1),
  }),
]);

const DraftJourneyCriterionInputSchema = z.union([
  z.string().min(1),
  JourneyCriterionSchema.partial({ id: true }).extend({
    statement: z.string().min(1),
  }),
]);

export const DraftJourneyInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    appName: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    testerProfile: z.string().min(1).optional(),
    objective: z.string().min(1).optional(),
    preconditions: z.array(z.string().min(1)).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    tasks: z.array(DraftJourneyTaskInputSchema).optional(),
    passCriteria: z.array(DraftJourneyCriterionInputSchema).optional(),
    failCriteria: z.array(DraftJourneyCriterionInputSchema).optional(),
    blockerCriteria: z.array(DraftJourneyCriterionInputSchema).optional(),
    riskLevel: z
      .enum(["read-only", "writes-test-data", "destructive"])
      .optional(),
  })
  .strict();

export type DraftJourneyInput = z.infer<typeof DraftJourneyInputSchema>;

export interface DraftUserJourneyOptions extends UserJourneyTemplateOptions {
  objective?: string;
  preconditions?: string[];
  data?: Record<string, unknown>;
  tasks?: Array<
    string | (Partial<JourneyTask> & Pick<JourneyTask, "instruction">)
  >;
  passCriteria?: Array<
    string | (Partial<JourneyCriterion> & Pick<JourneyCriterion, "statement">)
  >;
  failCriteria?: Array<
    string | (Partial<JourneyCriterion> & Pick<JourneyCriterion, "statement">)
  >;
  blockerCriteria?: Array<
    string | (Partial<JourneyCriterion> & Pick<JourneyCriterion, "statement">)
  >;
  input?: DraftJourneyInput;
}

export interface InitAuthoringProjectOptions extends UserJourneyTemplateOptions {
  rootDir?: string;
  profileId?: string;
  force?: boolean;
}

export type SchemaKind = "profile" | "journey" | "lifecycle" | "all";

export type LintSeverity = "error";

export interface LintIssue {
  severity: LintSeverity;
  code: string;
  path: string;
  message: string;
}

export interface LintUserJourneyOptions {
  profile?: TesterProfile;
}

export function createTesterProfileTemplate(
  options: TesterProfileTemplateOptions = {},
): TesterProfile {
  const id = options.id ?? "admin";
  const role = options.role ?? (id === "admin" ? "Admin" : titleFromId(id));
  const name = options.name ?? (id === "admin" ? "Workspace Admin" : `${role} Tester`);

  return TesterProfileSchema.parse({
    id,
    name,
    role,
    perspective:
      options.perspective ??
      (id === "admin"
        ? "Responsible for managing workspace users, permissions, and operational setup."
        : `Evaluate the app from the perspective of a ${role}.`),
    permissions:
      id === "admin"
        ? ["Can access admin settings", "Can invite users", "Can review user status"]
        : [
            "Can access the app area needed for this role",
            "Can complete the journey's normal in-app workflow",
            "Can review whether the action succeeded",
          ],
    goals:
      id === "admin"
        ? ["Complete admin tasks without developer knowledge", "Understand whether actions succeeded"]
        : [
            "Complete role-specific tasks without developer knowledge",
            "Understand whether actions succeeded",
          ],
    constraints: ["Use only normal in-app UI", "Do not use backend dashboards"],
  });
}

export function createUserJourneyTemplate(
  options: UserJourneyTemplateOptions = {},
): UserJourney {
  const id = options.id ?? "admin-invite-user";
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:3000";
  const riskLevel = options.riskLevel ?? "writes-test-data";
  const preconditions = [
    "The tester is authenticated as an admin.",
    "The workspace can safely create disposable test invitations.",
  ];

  if (riskLevel === "destructive") {
    preconditions.push(
      "The target data is disposable test data and there is an explicit cleanup or rollback plan.",
    );
  }

  return UserJourneySchema.parse({
    id,
    title: options.title ?? (id === "admin-invite-user" ? "Admin invites a teammate" : titleFromId(id)),
    app: {
      name: options.appName ?? "Acme Admin",
      baseUrl,
      allowedOrigins: [new URL(baseUrl).origin],
    },
    testerProfile: options.testerProfile ?? "admin",
    objective: "Invite a new teammate as a workspace admin.",
    preconditions,
    data: {
      email: "test+invite@example.com",
      role: "Member",
    },
    tasks: [
      {
        id: "find-user-management",
        instruction: "Find where admins manage users, members, or teammates.",
        expectedOutcome: "The tester reaches a user management area.",
      },
      {
        id: "send-invite",
        instruction: "Invite the test email address as a Member.",
        expectedOutcome: "The app accepts the invite request.",
      },
      {
        id: "verify-confirmation",
        instruction:
          "Confirm whether the app clearly communicates that the invitation was sent.",
        expectedOutcome: "The tester can point to visible confirmation.",
      },
    ],
    passCriteria: [
      {
        id: "invite-confirmed",
        statement:
          "The app clearly confirms that the invitation was sent to the specified email address.",
        requiredEvidence: ["videoTimestamp", "screenshot", "agentObservation"],
        severity: "critical",
      },
    ],
    failCriteria: [
      {
        id: "cannot-find-user-management",
        statement:
          "The tester cannot reasonably find where admins manage users, members, or teammates.",
        severity: "major",
      },
      {
        id: "invite-not-confirmed",
        statement:
          "The invite action appears to complete but the app does not clearly confirm that the invitation was sent.",
        severity: "critical",
      },
    ],
    blockerCriteria: [
      {
        id: "auth-blocked",
        statement:
          "The tester cannot access the admin area because authentication, permissions, or missing seed data blocks the journey.",
        severity: "critical",
      },
      ...(riskLevel === "destructive"
        ? [
            {
              id: "destructive-risk-blocked",
              statement:
                "Stop if the journey would delete, overwrite, or irreversibly change non-disposable data, or if cleanup guidance is unavailable.",
              severity: "critical" as const,
            },
          ]
        : []),
    ],
    riskLevel,
  });
}

export function createDraftUserJourney(
  options: DraftUserJourneyOptions = {},
): UserJourney {
  const input = options.input ?? {};
  const id = options.id ?? input.id ?? "draft-journey";
  const baseUrl = options.baseUrl ?? input.baseUrl ?? "http://127.0.0.1:3000";
  const riskLevel = options.riskLevel ?? input.riskLevel ?? "read-only";
  const objective =
    options.objective ??
    input.objective ??
    "Complete the drafted user journey and collect clear evidence for the outcome.";
  const preconditions = options.preconditions ?? input.preconditions ?? [];
  const data = options.data ?? input.data;
  const tasks = normalizeDraftTasks(options.tasks ?? input.tasks, objective);
  const passCriteria = normalizeDraftCriteria(
    options.passCriteria ?? input.passCriteria,
    "pass",
    objective,
  );
  const failCriteria = normalizeDraftCriteria(
    options.failCriteria ?? input.failCriteria,
    "fail",
    objective,
  );
  const blockerCriteria = normalizeDraftCriteria(
    options.blockerCriteria ?? input.blockerCriteria,
    "blocker",
    objective,
  );

  if (riskLevel === "destructive" && blockerCriteria.length === 0) {
    blockerCriteria.push({
      id: "unsafe-destructive-action",
      statement:
        "Stop if the journey would delete, overwrite, or irreversibly change non-disposable data, or if cleanup guidance is unavailable.",
      severity: "critical",
    });
  }

  return UserJourneySchema.parse({
    id,
    title: options.title ?? input.title ?? titleFromId(id),
    app: {
      name: options.appName ?? input.appName ?? "Draft App",
      baseUrl,
      allowedOrigins: [new URL(baseUrl).origin],
    },
    testerProfile: options.testerProfile ?? input.testerProfile ?? "admin",
    objective,
    ...(preconditions.length > 0 ? { preconditions } : {}),
    ...(data ? { data } : {}),
    tasks,
    passCriteria,
    failCriteria,
    ...(blockerCriteria.length > 0 ? { blockerCriteria } : {}),
    riskLevel,
  });
}

export async function initAuthoringProject(
  options: InitAuthoringProjectOptions = {},
): Promise<{ profilePath: string; journeyPath: string }> {
  const rootDir = options.rootDir ?? defaultAuthoringDir;
  const profileId = options.profileId ?? options.testerProfile ?? "admin";
  const journeyId = options.id ?? "admin-invite-user";
  const profile = createTesterProfileTemplate({ id: profileId });
  const journey = createUserJourneyTemplate({
    id: journeyId,
    title: options.title,
    appName: options.appName,
    baseUrl: options.baseUrl,
    testerProfile: profileId,
    riskLevel: options.riskLevel,
  });
  const profilePath = join(rootDir, "profiles", `${profile.id}.json`);
  const journeyPath = join(rootDir, "journeys", `${journey.id}.json`);

  await writeJsonDocument(profilePath, profile, { force: options.force });
  await writeJsonDocument(journeyPath, journey, { force: options.force });

  return { profilePath, journeyPath };
}

export async function writeJsonDocument(
  path: string,
  value: unknown,
  options: { force?: boolean } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, stringifyJsonDocument(value), {
      encoding: "utf8",
      flag: options.force ? "w" : "wx",
    });
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
    if (code === "EEXIST") {
      throw new Error(`${path} already exists. Pass --force to overwrite it.`);
    }
    throw error;
  }
}

export function stringifyJsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function createJsonSchemaDocument(kind: SchemaKind = "all"): unknown {
  const schemas = {
    profile: z.toJSONSchema(TesterProfileSchema, {
      target: "draft-7",
      io: "input",
      unrepresentable: "any",
    }),
    journey: z.toJSONSchema(UserJourneySchema, {
      target: "draft-7",
      io: "input",
      unrepresentable: "any",
    }),
    lifecycle: z.toJSONSchema(DataLifecycleConfigSchema, {
      target: "draft-7",
      io: "input",
      unrepresentable: "any",
    }),
  };

  if (kind === "all") {
    return {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "JourneyTest authoring schemas",
      schemas,
    };
  }

  return schemas[kind];
}

export function parseSchemaKind(value: string): SchemaKind {
  if (value === "profile" || value === "journey" || value === "lifecycle" || value === "all") {
    return value;
  }

  throw new Error(`Unknown schema "${value}". Expected profile, journey, lifecycle, or all.`);
}

export function lintUserJourney(
  journey: UserJourney,
  options: LintUserJourneyOptions = {},
): LintIssue[] {
  const issues: LintIssue[] = [];

  for (const issue of validateAllowedOrigins(journey)) {
    issues.push({
      severity: "error",
      code: "allowed-origins",
      path: issue.path,
      message: issue.message,
    });
  }

  if (options.profile) {
    for (const issue of validateJourneyProfileMatch(journey, options.profile)) {
      issues.push({
        severity: "error",
        code: "profile-mismatch",
        path: issue.path,
        message: issue.message,
      });
    }
  }

  if (!journey.blockerCriteria || journey.blockerCriteria.length === 0) {
    issues.push({
      severity: "error",
      code: "missing-blocker-criteria",
      path: "blockerCriteria",
      message:
        "Add blockerCriteria for missing auth, permissions, seed data, unavailable services, or app crashes that prevent evaluation.",
    });
  }

  journey.failCriteria.forEach((criterion, index) => {
    if (isWeakFailCriterion(criterion.statement)) {
      issues.push({
        severity: "error",
        code: "weak-fail-criterion",
        path: `failCriteria.${index}.statement`,
        message: `Fail criterion "${criterion.id}" is too generic. Describe an observable user-facing failure state.`,
      });
    }
  });

  journey.passCriteria.forEach((criterion, index) => {
    if (criterion.severity === "critical" && !hasRequiredEvidence(criterion)) {
      issues.push({
        severity: "error",
        code: "critical-pass-evidence",
        path: `passCriteria.${index}.requiredEvidence`,
        message: `Critical pass criterion "${criterion.id}" must declare requiredEvidence.`,
      });
    }
  });

  if (journey.riskLevel === "destructive") {
    if (!hasExplicitDestructiveBlocker(journey)) {
      issues.push({
        severity: "error",
        code: "destructive-risk-blocker",
        path: "blockerCriteria",
        message:
          "Destructive journeys need an explicit blocker for unsafe deletes, overwrites, production data, or missing authorization.",
      });
    }

    if (!hasCleanupGuidance(journey)) {
      issues.push({
        severity: "error",
        code: "destructive-risk-cleanup",
        path: "dataLifecycle.cleanup",
        message:
          "Destructive journeys need explicit cleanup, rollback, restore, or disposable-test-data guidance.",
      });
    }
  }

  return issues;
}

export function formatLintIssue(issue: LintIssue): string {
  return `${issue.severity} ${issue.code} ${issue.path}: ${issue.message}`;
}

function hasRequiredEvidence(criterion: JourneyCriterion): boolean {
  return Boolean(criterion.requiredEvidence && criterion.requiredEvidence.length > 0);
}

function isWeakFailCriterion(statement: string): boolean {
  const normalized = normalizeText(statement);
  const words = normalized.split(/\s+/).filter(Boolean);
  const weakPatterns = [
    /\bthe test fails?\b/,
    /\bthe journey fails?\b/,
    /\btest does not pass\b/,
    /\bsomething (goes|went) wrong\b/,
    /\bdoes not work\b/,
    /\bdoesn't work\b/,
    /\bno bugs?\b/,
    /\bbugs? happen\b/,
    /\berror happens?\b/,
    /\bthere is an error\b/,
    /^fails?$/,
    /^failure$/,
    /^cannot complete$/,
  ];

  return (
    weakPatterns.some((pattern) => pattern.test(normalized)) ||
    (words.length < 4 && /\b(fail|fails|failure|broken|error|bug|issue|problem)\b/.test(normalized))
  );
}

function hasExplicitDestructiveBlocker(journey: UserJourney): boolean {
  return (journey.blockerCriteria ?? []).some((criterion) =>
    /\b(delete|destructive|irreversible|overwrite|unsafe|production|real data|authorization|permission)\b/.test(
      normalizeText(criterion.statement),
    ),
  );
}

function hasCleanupGuidance(journey: UserJourney): boolean {
  if (journey.dataLifecycle?.cleanup) {
    return true;
  }

  const text = [
    ...collectText(journey.preconditions ?? []),
    ...journey.tasks.flatMap((task) =>
      collectText([task.instruction, task.expectedOutcome, JSON.stringify(task.data ?? {})]),
    ),
    ...journey.passCriteria.flatMap(criterionText),
    ...journey.failCriteria.flatMap(criterionText),
    ...(journey.blockerCriteria ?? []).flatMap(criterionText),
  ].join(" ");

  return /\b(clean ?up|restore|rollback|undo|disposable|test data|fixture|reversible)\b/.test(
    normalizeText(text),
  );
}

function criterionText(criterion: JourneyCriterion): string[] {
  return collectText([criterion.statement, criterion.notes]);
}

function collectText(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replaceAll("’", "'");
}

function normalizeDraftTasks(
  tasks: DraftUserJourneyOptions["tasks"] | DraftJourneyInput["tasks"] | undefined,
  objective: string,
): JourneyTask[] {
  const taskInputs =
    tasks && tasks.length > 0
      ? tasks
      : [
          {
            instruction: objective,
            expectedOutcome:
              "The tester can determine whether the objective was completed.",
          },
        ];

  return taskInputs.map((task, index) => {
    if (typeof task === "string") {
      return JourneyTaskSchema.parse({
        id: stableGeneratedId("task", task, index),
        instruction: task,
      });
    }

    return JourneyTaskSchema.parse({
      ...task,
      id: task.id ?? stableGeneratedId("task", task.instruction, index),
    });
  });
}

function normalizeDraftCriteria(
  criteria:
    | DraftUserJourneyOptions["passCriteria"]
    | DraftUserJourneyOptions["failCriteria"]
    | DraftUserJourneyOptions["blockerCriteria"]
    | DraftJourneyInput["passCriteria"]
    | DraftJourneyInput["failCriteria"]
    | DraftJourneyInput["blockerCriteria"]
    | undefined,
  kind: "pass" | "fail" | "blocker",
  objective: string,
): JourneyCriterion[] {
  const criterionInputs =
    criteria && criteria.length > 0
      ? criteria
      : kind === "pass"
        ? [
            {
              statement: `The tester completes the objective: ${objective}`,
              requiredEvidence: ["agentObservation"] satisfies EvidenceKind[],
              severity: "critical" as const,
            },
          ]
        : kind === "fail"
          ? [
              {
                statement: `The tester cannot complete the objective: ${objective}`,
                severity: "major" as const,
              },
            ]
          : [];

  return criterionInputs.map((criterion, index) => {
    if (typeof criterion === "string") {
      return JourneyCriterionSchema.parse({
        id: stableGeneratedId(kind, criterion, index),
        statement: criterion,
        ...(kind === "pass"
          ? {
              requiredEvidence: [EvidenceKindSchema.enum.agentObservation],
              severity: "critical",
            }
          : kind === "fail"
            ? { severity: "major" }
            : { severity: "critical" }),
      });
    }

    return JourneyCriterionSchema.parse({
      ...criterion,
      id: criterion.id ?? stableGeneratedId(kind, criterion.statement, index),
    });
  });
}

function stableGeneratedId(prefix: string, text: string, index: number): string {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 48)
    .replaceAll(/-$/g, "");

  return `${prefix}-${slug || index + 1}`;
}

function titleFromId(id: string): string {
  return id
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}
