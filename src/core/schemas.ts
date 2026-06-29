import { z } from "zod";

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const EvidenceKindSchema = z.enum([
  "videoTimestamp",
  "screenshot",
  "snapshot",
  "url",
  "agentObservation",
  "console",
  "network",
  "uiChangeTimeline",
]);

export const SeveritySchema = z.enum(["info", "minor", "major", "critical"]);

export const FindingCategorySchema = z.enum([
  "ux",
  "ui",
  "accessibility",
  "performance",
  "bug",
  "copy",
  "blocker",
  "security",
]);

export const TesterProfileSchema = z
  .object({
    id: z.string().min(1).regex(idPattern),
    name: z.string().min(1),
    role: z.string().min(1),
    perspective: z.string().min(1),
    permissions: z.array(z.string().min(1)).optional(),
    goals: z.array(z.string().min(1)).optional(),
    constraints: z.array(z.string().min(1)).optional(),
    notes: z.string().optional(),
  })
  .strict();

export const AppTargetSchema = z
  .object({
    name: z.string().min(1),
    baseUrl: z.string().url(),
    allowedOrigins: z.array(z.string().url()).optional(),
  })
  .strict();

export const ViewportSizeSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    deviceScaleFactor: z.number().positive().optional(),
  })
  .strict();

export const BrowserDevicePresetSchema = z.enum([
  "iphone-14",
  "pixel-7",
  "ipad-pro-11",
]);

export const BrowserEnvironmentSchema = z
  .object({
    viewport: ViewportSizeSchema.optional(),
    device: BrowserDevicePresetSchema.optional(),
  })
  .strict();

export const JourneyTaskSchema = z
  .object({
    id: z.string().min(1).regex(idPattern),
    instruction: z.string().min(1),
    expectedOutcome: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    evidence: z.array(EvidenceKindSchema).optional(),
  })
  .strict();

export const JourneyCriterionSchema = z
  .object({
    id: z.string().min(1).regex(idPattern),
    statement: z.string().min(1),
    requiredEvidence: z.array(EvidenceKindSchema).optional(),
    severity: SeveritySchema.optional(),
    notes: z.string().optional(),
  })
  .strict();

export const EvidenceRequirementSchema = z
  .object({
    kind: EvidenceKindSchema,
    description: z.string().min(1),
    required: z.boolean().default(true),
  })
  .strict();

const DataLifecycleOperationListSchema = <T extends z.ZodType>(schema: T) =>
  z
    .union([schema, z.array(schema)])
    .transform((value) => (Array.isArray(value) ? value : [value]));

export const DataLifecyclePhaseSchema = z.enum([
  "setup",
  "preflight",
  "postconditions",
  "cleanup",
]);

export const DataLifecycleOperationKindSchema = z.enum([
  "query",
  "mutation",
  "action",
]);

export const DataLifecycleCapabilitySchema = z.enum([
  "publicFunctions",
  "internalFunctions",
]);

export const DataLifecycleCheckSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(["pass", "warn", "fail"]),
    message: z.string().min(1).optional(),
    data: z.unknown().optional(),
  })
  .strict();

export const DataLifecycleOperationSchema = z
  .object({
    id: z.string().min(1).regex(idPattern).optional(),
    kind: DataLifecycleOperationKindSchema.default("mutation"),
    function: z.string().min(1),
    args: z.unknown().optional(),
    manifestPath: z.string().min(1).optional(),
    requiredCapabilities: z.array(DataLifecycleCapabilitySchema).optional(),
    allowFailure: z.boolean().default(false),
    redactKeys: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const DataLifecycleDefinitionSchema = z
  .object({
    environment: z.string().min(1).regex(idPattern),
    namespace: z.string().min(1).optional(),
    setup: DataLifecycleOperationListSchema(
      DataLifecycleOperationSchema,
    ).optional(),
    preflight: z.array(DataLifecycleOperationSchema).optional(),
    postconditions: z.array(DataLifecycleOperationSchema).optional(),
    cleanup: DataLifecycleOperationListSchema(
      DataLifecycleOperationSchema,
    ).optional(),
  })
  .strict();

export const DataLifecycleEnvironmentCapabilitiesSchema = z
  .object({
    publicFunctions: z.boolean().optional(),
    internalFunctions: z.boolean().optional(),
  })
  .strict();

export const ConvexDataEnvironmentSchema = z
  .object({
    provider: z.literal("convex"),
    transport: z.enum(["http", "cli"]),
    url: z.string().url().optional(),
    urlEnv: z.string().min(1).optional(),
    authTokenEnv: z.string().min(1).optional(),
    projectDir: z.string().min(1).optional(),
    deployment: z.string().min(1).optional(),
    prod: z.boolean().optional(),
    push: z.boolean().optional(),
    capabilities: DataLifecycleEnvironmentCapabilitiesSchema.optional(),
  })
  .strict()
  .superRefine((environment, context) => {
    if (
      environment.transport === "http" &&
      !environment.url &&
      !environment.urlEnv
    ) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "Convex HTTP environments require url or urlEnv.",
      });
    }
  });

export const ScriptDataEnvironmentSchema = z
  .object({
    provider: z.literal("script"),
    command: z.string().min(1).optional(),
    commandArgs: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string().min(1), z.string()).optional(),
    passArgs: z.enum(["json-argv", "json-stdin", "none"]).default("json-argv"),
    timeoutMs: z.number().int().positive().optional(),
    capabilities: DataLifecycleEnvironmentCapabilitiesSchema.optional(),
  })
  .strict();

export const HttpDataEnvironmentSchema = z
  .object({
    provider: z.literal("http"),
    url: z.string().url().optional(),
    urlEnv: z.string().min(1).optional(),
    headers: z.record(z.string().min(1), z.string()).optional(),
    authHeader: z.string().min(1).default("Authorization"),
    authScheme: z.string().default("Bearer"),
    authTokenEnv: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    capabilities: DataLifecycleEnvironmentCapabilitiesSchema.optional(),
  })
  .strict()
  .superRefine((environment, context) => {
    if (!environment.url && !environment.urlEnv) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "HTTP data lifecycle environments require url or urlEnv.",
      });
    }
  });

export const DataEnvironmentSchema = z.discriminatedUnion("provider", [
  ConvexDataEnvironmentSchema,
  ScriptDataEnvironmentSchema,
  HttpDataEnvironmentSchema,
]);

export const DataLifecycleConfigSchema = z
  .object({
    dataEnvironments: z.record(
      z.string().min(1).regex(idPattern),
      DataEnvironmentSchema,
    ),
    suiteLifecycle: DataLifecycleDefinitionSchema.optional(),
    appLifecycle: z
      .object({
        ports: z
          .record(
            z.string().min(1).regex(idPattern),
            z
              .object({
                host: z.string().min(1).default("127.0.0.1"),
              })
              .strict(),
          )
          .optional(),
        app: z
          .object({
            baseUrl: z.string().min(1).optional(),
            allowedOrigins: z.array(z.string().min(1)).optional(),
          })
          .strict()
          .optional(),
        start: z
          .object({
            command: z.string().min(1),
            commandArgs: z.array(z.string()).optional(),
            cwd: z.string().min(1).optional(),
            env: z.record(z.string().min(1), z.string()).optional(),
            passContext: z
              .enum(["json-argv", "json-stdin", "none"])
              .default("json-argv"),
            timeoutMs: z.number().int().positive().optional(),
          })
          .strict(),
        cleanup: z
          .object({
            command: z.string().min(1),
            commandArgs: z.array(z.string()).optional(),
            cwd: z.string().min(1).optional(),
            env: z.record(z.string().min(1), z.string()).optional(),
            passContext: z
              .enum(["json-argv", "json-stdin", "none"])
              .default("json-argv"),
            timeoutMs: z.number().int().positive().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const UserJourneySchema = z
  .object({
    id: z.string().min(1).regex(idPattern),
    title: z.string().min(1),
    tags: z.array(z.string().min(1).regex(idPattern)).optional(),
    quarantined: z.boolean().optional(),
    app: AppTargetSchema,
    testerProfile: z.string().min(1).regex(idPattern),
    objective: z.string().min(1),
    preconditions: z.array(z.string().min(1)).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    dataLifecycle: DataLifecycleDefinitionSchema.optional(),
    tasks: z.array(JourneyTaskSchema).min(1),
    passCriteria: z.array(JourneyCriterionSchema).min(1),
    failCriteria: z.array(JourneyCriterionSchema).min(1),
    blockerCriteria: z.array(JourneyCriterionSchema).optional(),
    evidenceRequirements: z.array(EvidenceRequirementSchema).optional(),
    browserEnvironment: BrowserEnvironmentSchema.optional(),
    riskLevel: z
      .enum(["read-only", "writes-test-data", "destructive"])
      .default("read-only"),
  })
  .strict();

export const EvidenceReferenceSchema = z
  .object({
    videoTimeMs: z.number().int().nonnegative().optional(),
    screenshot: z.string().min(1).optional(),
    snapshot: z.string().min(1).optional(),
    url: z.string().url().optional(),
    observation: z.string().min(1).optional(),
    console: z.string().min(1).optional(),
    network: z.string().min(1).optional(),
    uiChangeTimeline: z.string().min(1).optional(),
  })
  .strict();

export const CriterionAssessmentSchema = z
  .object({
    id: z.string().min(1).regex(idPattern),
    result: z.enum(["met", "not-met", "blocked", "not-observed"]),
    explanation: z.string().min(1),
    evidence: EvidenceReferenceSchema.optional(),
  })
  .strict();

export const FindingSchema = z
  .object({
    id: z.string().min(1).regex(idPattern),
    severity: SeveritySchema.default("info"),
    category: FindingCategorySchema,
    title: z.string().min(1),
    description: z.string().min(1),
    evidence: EvidenceReferenceSchema.optional(),
    recommendation: z.string().optional(),
  })
  .strict();

export const AgentVerdictSchema = z
  .object({
    status: z.enum(["passed", "failed", "blocked", "inconclusive"]),
    confidence: z.enum(["low", "medium", "high"]),
    summary: z.string().min(1),
    criteria: z.array(CriterionAssessmentSchema).min(1),
    blockers: z.array(FindingSchema).default([]),
    uxFindings: z.array(FindingSchema).default([]),
    suggestedImprovements: z.array(FindingSchema).default([]),
  })
  .strict();

export const TimelineEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    wallTime: z.string().datetime(),
    elapsedMs: z.number().int().nonnegative(),
    videoTimeMs: z.number().int().nonnegative().optional(),
    taskId: z.string().min(1).optional(),
    summary: z.string().min(1),
    data: z.unknown().optional(),
  })
  .strict();

export const VideoBookmarkSchema = z
  .object({
    id: z.string().min(1).regex(idPattern),
    timeMs: z.number().int().nonnegative(),
    label: z.string().min(1),
    detail: z.string().optional(),
    sourceEventIds: z.array(z.string().min(1)).optional(),
    kind: z.enum(["action", "milestone", "finding"]).default("action"),
  })
  .strict();

export const RunArtifactsSchema = z
  .object({
    runDir: z.string().min(1),
    events: z.string().min(1),
    dashboard: z.string().min(1),
    report: z.string().min(1),
    result: z.string().min(1),
    video: z.string().min(1).optional(),
    videoOriginal: z.string().min(1).optional(),
    videoClips: z.array(z.string().min(1)).default([]),
    screenshots: z.array(z.string().min(1)).default([]),
    snapshots: z.array(z.string().min(1)).default([]),
    console: z.array(z.string().min(1)).default([]),
    network: z.array(z.string().min(1)).default([]),
    uiChanges: z.array(z.string().min(1)).default([]),
    dataLifecycle: z
      .object({
        setup: z.string().min(1).optional(),
        preflight: z.string().min(1).optional(),
        postconditions: z.string().min(1).optional(),
        cleanup: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const VideoProcessingSchema = z
  .object({
    mode: z.literal("action-clips").optional(),
    actionClipCount: z.number().int().nonnegative().optional(),
    actionClipStitched: z.boolean().optional(),
    actionClipStitchReason: z.string().optional(),
    trimmedSolidColorStart: z.boolean().optional(),
    trimOffsetMs: z.number().int().nonnegative().optional(),
    originalVideo: z.string().min(1).optional(),
    staticFrameCondensed: z.boolean().optional(),
    staticFrameRemovedMs: z.number().int().nonnegative().optional(),
    staticFrameSegments: z
      .array(
        z
          .object({
            startMs: z.number().int().nonnegative(),
            endMs: z.number().int().nonnegative(),
            durationMs: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const DataLifecycleOperationResultSchema = z
  .object({
    id: z.string().min(1),
    phase: DataLifecyclePhaseSchema,
    environment: z.string().min(1),
    provider: z.string().min(1),
    transport: z.string().min(1).optional(),
    kind: DataLifecycleOperationKindSchema,
    function: z.string().min(1),
    status: z.enum(["passed", "failed", "skipped"]),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative(),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    checks: z.array(DataLifecycleCheckSchema).optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    httpStatus: z.number().int().optional(),
    error: z
      .object({
        message: z.string().min(1),
        stack: z.string().optional(),
        classification: z
          .enum(["configuration", "capability", "execution", "assertion"])
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const DataLifecycleExecutionSchema = z
  .object({
    schemaVersion: z.literal("0.1"),
    scope: z.enum(["suite", "journey"]),
    environment: z.string().min(1),
    namespace: z.string().min(1),
    status: z.enum(["passed", "failed", "blocked", "skipped"]),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    manifest: z.unknown().optional(),
    suiteManifest: z.unknown().optional(),
    artifacts: z
      .object({
        setup: z.string().min(1).optional(),
        preflight: z.string().min(1).optional(),
        postconditions: z.string().min(1).optional(),
        cleanup: z.string().min(1).optional(),
      })
      .strict(),
    setup: z.array(DataLifecycleOperationResultSchema).default([]),
    preflight: z.array(DataLifecycleOperationResultSchema).default([]),
    postconditions: z.array(DataLifecycleOperationResultSchema).default([]),
    cleanup: z.array(DataLifecycleOperationResultSchema).default([]),
  })
  .strict();

export const RunAttemptSchema = z
  .object({
    attempt: z.number().int().positive(),
    runId: z.string().min(1),
    runStatus: z.enum(["completed", "error", "cancelled", "blocked"]),
    verdictStatus: z
      .enum(["passed", "failed", "blocked", "inconclusive"])
      .optional(),
    dataLifecycleStatus: z
      .enum(["passed", "failed", "blocked", "skipped"])
      .optional(),
    passed: z.boolean(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative(),
    dashboard: z.string().min(1),
    result: z.string().min(1),
    summary: z.string().min(1).optional(),
  })
  .strict();

export const RunFlakeSchema = z
  .object({
    isFlaky: z.boolean(),
    retries: z.number().int().nonnegative(),
    attempts: z.number().int().positive(),
    passedAttempt: z.number().int().positive().optional(),
    failedAttemptsBeforePass: z.number().int().nonnegative(),
  })
  .strict();

export const RunQuarantineSchema = z
  .object({
    quarantined: z.boolean(),
  })
  .strict();

export const RunResultSchema = z
  .object({
    schemaVersion: z.literal("0.1"),
    runId: z.string().min(1),
    journeyId: z.string().min(1),
    testerProfileId: z.string().min(1),
    runStatus: z.enum(["completed", "error", "cancelled", "blocked"]),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative(),
    model: z
      .object({
        provider: z.string().min(1),
        name: z.string().min(1),
      })
      .strict()
      .optional(),
    verdict: AgentVerdictSchema.optional(),
    error: z
      .object({
        message: z.string().min(1),
        stack: z.string().optional(),
      })
      .strict()
      .optional(),
    bookmarks: z.array(VideoBookmarkSchema).optional(),
    videoProcessing: VideoProcessingSchema.optional(),
    dataLifecycle: DataLifecycleExecutionSchema.optional(),
    attempts: z.array(RunAttemptSchema).optional(),
    flake: RunFlakeSchema.optional(),
    quarantine: RunQuarantineSchema.optional(),
    browserEnvironment: BrowserEnvironmentSchema.optional(),
    artifacts: RunArtifactsSchema,
    timeline: z.array(TimelineEventSchema),
  })
  .strict();

export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type FindingCategory = z.infer<typeof FindingCategorySchema>;
export type TesterProfile = z.infer<typeof TesterProfileSchema>;
export type AppTarget = z.infer<typeof AppTargetSchema>;
export type BrowserViewport = z.infer<typeof ViewportSizeSchema>;
export type BrowserDevicePreset = z.infer<typeof BrowserDevicePresetSchema>;
export type BrowserEnvironment = z.infer<typeof BrowserEnvironmentSchema>;
export type JourneyTask = z.infer<typeof JourneyTaskSchema>;
export type JourneyCriterion = z.infer<typeof JourneyCriterionSchema>;
export type EvidenceRequirement = z.infer<typeof EvidenceRequirementSchema>;
export type DataLifecyclePhase = z.infer<typeof DataLifecyclePhaseSchema>;
export type DataLifecycleOperationKind = z.infer<
  typeof DataLifecycleOperationKindSchema
>;
export type DataLifecycleCapability = z.infer<
  typeof DataLifecycleCapabilitySchema
>;
export type DataLifecycleCheck = z.infer<typeof DataLifecycleCheckSchema>;
export type DataLifecycleOperation = z.infer<
  typeof DataLifecycleOperationSchema
>;
export type DataLifecycleDefinition = z.infer<
  typeof DataLifecycleDefinitionSchema
>;
export type ConvexDataEnvironment = z.infer<typeof ConvexDataEnvironmentSchema>;
export type ScriptDataEnvironment = z.infer<typeof ScriptDataEnvironmentSchema>;
export type HttpDataEnvironment = z.infer<typeof HttpDataEnvironmentSchema>;
export type DataEnvironment = z.infer<typeof DataEnvironmentSchema>;
export type DataLifecycleConfig = z.infer<typeof DataLifecycleConfigSchema>;
export type UserJourney = z.infer<typeof UserJourneySchema>;
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type CriterionAssessment = z.infer<typeof CriterionAssessmentSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type AgentVerdict = z.infer<typeof AgentVerdictSchema>;
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export type VideoBookmark = z.infer<typeof VideoBookmarkSchema>;
export type RunArtifacts = z.infer<typeof RunArtifactsSchema>;
export type RunAttempt = z.infer<typeof RunAttemptSchema>;
export type RunFlake = z.infer<typeof RunFlakeSchema>;
export type RunQuarantine = z.infer<typeof RunQuarantineSchema>;
export type VideoProcessing = z.infer<typeof VideoProcessingSchema>;
export type DataLifecycleOperationResult = z.infer<
  typeof DataLifecycleOperationResultSchema
>;
export type DataLifecycleExecution = z.infer<
  typeof DataLifecycleExecutionSchema
>;
export type RunResult = z.infer<typeof RunResultSchema>;

export function parseTesterProfile(input: unknown): TesterProfile {
  return TesterProfileSchema.parse(input);
}

export function parseUserJourney(input: unknown): UserJourney {
  return UserJourneySchema.parse(input);
}

export function parseAgentVerdict(input: unknown): AgentVerdict {
  return AgentVerdictSchema.parse(input);
}
