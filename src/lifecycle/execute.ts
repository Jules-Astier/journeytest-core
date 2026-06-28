import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DataEnvironment,
  DataLifecycleCheck,
  DataLifecycleDefinition,
  DataLifecycleExecution,
  DataLifecycleOperation,
  DataLifecycleOperationResult,
  DataLifecyclePhase,
  TesterProfile,
  UserJourney,
} from "../core/schemas.js";
import {
  DataLifecycleBlockedError,
  type DataLifecycleProvider,
  DataLifecycleProviderError,
} from "./types.js";
import { redactSensitiveText, redactSensitiveValue } from "../utils/redaction.js";

const phaseOrder: DataLifecyclePhase[] = [
  "setup",
  "preflight",
  "postconditions",
  "cleanup",
];

export interface DataLifecycleControllerOptions {
  definition: DataLifecycleDefinition;
  environments: Record<string, DataEnvironment>;
  provider: DataLifecycleProvider;
  scope: "suite" | "journey";
  runId: string;
  runDir: string;
  suiteRunId?: string;
  journeyRunId?: string;
  journey?: UserJourney;
  profile?: TesterProfile;
  suiteManifest?: unknown;
  keepData?: boolean;
}

export class DataLifecycleController {
  readonly result: DataLifecycleExecution;
  manifest: unknown;

  private readonly environment: DataEnvironment;
  private readonly startedAt: Date;
  private manifestRedactValues: string[] = [];
  private blocked = false;

  constructor(private readonly options: DataLifecycleControllerOptions) {
    const environment = options.environments[options.definition.environment];
    if (!environment) {
      throw new Error(
        `No data lifecycle environment named "${options.definition.environment}" was configured.`,
      );
    }

    this.environment = environment;
    this.startedAt = new Date();
    const namespace =
      options.definition.namespace ??
      `jt_${sanitizeNamespace(options.journey?.id ?? options.runId)}_${shortRunId(options.runId)}`;
    const artifacts = Object.fromEntries(
      phaseOrder.map((phase) => [phase, join(options.runDir, `${phase}.json`)]),
    ) as DataLifecycleExecution["artifacts"];

    this.result = {
      schemaVersion: "0.1",
      scope: options.scope,
      environment: options.definition.environment,
      namespace,
      status: "passed",
      startedAt: this.startedAt.toISOString(),
      ...(options.suiteManifest === undefined
        ? {}
        : { suiteManifest: redactSensitiveValue(options.suiteManifest) }),
      artifacts,
      setup: [],
      preflight: [],
      postconditions: [],
      cleanup: [],
    };
  }

  get artifactPaths(): DataLifecycleExecution["artifacts"] {
    return this.result.artifacts;
  }

  async runSetupAndPreflight(): Promise<void> {
    await this.runPhase("setup");
    await this.runPhase("preflight");

    const blockingFailures = [...this.result.setup, ...this.result.preflight].filter(
      (operation) => operation.status === "failed",
    );
    if (blockingFailures.length > 0) {
      this.blocked = true;
      this.finish("blocked");
      throw new DataLifecycleBlockedError(
        `Data lifecycle blocked the run with ${blockingFailures.length} setup/preflight failure(s).`,
        blockingFailures,
      );
    }
  }

  async runPostconditions(): Promise<void> {
    if (!this.blocked) {
      await this.runPhase("postconditions");
    } else {
      await this.writePhaseArtifact("postconditions", "skipped");
    }
  }

  async runCleanup(): Promise<void> {
    if (this.options.keepData) {
      await this.writePhaseArtifact("cleanup", "skipped");
      this.finish(this.result.status);
      return;
    }

    await this.runPhase("cleanup");
  }

  finish(status = this.result.status): void {
    const endedAt = new Date();
    this.result.status = status;
    this.result.endedAt = endedAt.toISOString();
    this.result.durationMs = Math.max(0, endedAt.getTime() - this.startedAt.getTime());
    if (this.manifest !== undefined) {
      this.result.manifest = redactSensitiveValue(this.manifest, {
        extraValues: this.manifestRedactValues,
      });
    }
  }

  private async runPhase(phase: DataLifecyclePhase): Promise<void> {
    const operations = operationsForPhase(this.options.definition, phase);
    if (operations.length === 0) {
      await this.writePhaseArtifact(phase, "skipped");
      return;
    }

    for (const [index, operation] of operations.entries()) {
      const { operationResult, rawResult, redactValues } = await this.runOperation(phase, operation, index);
      this.result[phase].push(operationResult);

      if (phase === "setup" && operationResult.status === "passed" && rawResult !== undefined) {
        this.captureManifest(operation, rawResult, redactValues);
      }
    }

    const failed = this.result[phase].some(
      (operation) => operation.status === "failed" && !operationAllowFailure(operations, operation),
    );
    if (failed) {
      this.result.status =
        phase === "setup" || phase === "preflight" ? "blocked" : "failed";
    }

    await this.writePhaseArtifact(phase, failed ? this.result.status : "passed");
  }

  private async runOperation(
    phase: DataLifecyclePhase,
    operation: DataLifecycleOperation,
    index: number,
  ): Promise<{
    operationResult: DataLifecycleOperationResult;
    rawResult?: unknown;
    redactValues?: string[];
  }> {
    const startedAt = new Date();
    const operationId = operation.id ?? `${phase}-${index + 1}`;
    const inheritedRedactValues = this.manifestRedactValues;
    const resolvedArgs = resolveTemplate(operation.args, {
      context: {
        scope: this.options.scope,
        runId: this.options.runId,
        suiteRunId: this.options.suiteRunId,
        journeyRunId: this.options.journeyRunId,
        journeyId: this.options.journey?.id,
        testerProfileId: this.options.profile?.id,
        namespace: this.result.namespace,
        environment: this.result.environment,
      },
      manifest: this.manifest,
      suiteManifest: this.options.suiteManifest,
      env: process.env,
    });

    try {
      assertCapabilities(this.environment, operation);
      const providerResult = await this.options.provider.runOperation({
        scope: this.options.scope,
        runId: this.options.runId,
        suiteRunId: this.options.suiteRunId,
        journeyRunId: this.options.journeyRunId,
        journey: this.options.journey,
        profile: this.options.profile,
        namespace: this.result.namespace,
        manifest: this.manifest,
        suiteManifest: this.options.suiteManifest,
        environmentName: this.result.environment,
        environment: this.environment,
        phase,
        operation,
        args: resolvedArgs,
      });
      const endedAt = new Date();
      const checks = extractChecks(providerResult.result);
      const assertionFailed = checks?.some((check) => check.status === "fail") ?? false;
      const status = assertionFailed && !operation.allowFailure ? "failed" : "passed";
      const redactValues = combineRedactValues(inheritedRedactValues, providerResult.redactValues);
      const assertionError =
        status === "failed" && assertionFailed
          ? {
              message: redactSensitiveText(assertionFailureMessage(checks), { extraValues: redactValues }),
              classification: "assertion" as const,
            }
          : undefined;

      return {
        operationResult: {
          id: operationId,
          phase,
          environment: this.result.environment,
          provider: this.environment.provider,
          transport: "transport" in this.environment ? this.environment.transport : undefined,
          kind: operation.kind,
          function: operation.function,
          status,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
          ...(resolvedArgs === undefined
            ? {}
            : {
                args: redactSensitiveValue(resolvedArgs, {
                  extraKeys: operation.redactKeys,
                  extraValues: redactValues,
                }),
              }),
          ...(providerResult.result === undefined
            ? {}
            : {
                result: redactSensitiveValue(providerResult.result, {
                  extraKeys: operation.redactKeys,
                  extraValues: redactValues,
                }),
              }),
          ...(checks
            ? {
                checks: redactSensitiveValue(checks, {
                  extraKeys: operation.redactKeys,
                  extraValues: redactValues,
                }) as DataLifecycleCheck[],
              }
            : {}),
          ...(providerResult.stdout
            ? { stdout: redactSensitiveText(providerResult.stdout, { extraValues: redactValues }) }
            : {}),
          ...(providerResult.stderr
            ? { stderr: redactSensitiveText(providerResult.stderr, { extraValues: redactValues }) }
            : {}),
          ...(providerResult.exitCode === undefined ? {} : { exitCode: providerResult.exitCode }),
          ...(providerResult.signal ? { signal: providerResult.signal } : {}),
          ...(providerResult.httpStatus === undefined ? {} : { httpStatus: providerResult.httpStatus }),
          ...(assertionError ? { error: assertionError } : {}),
        },
        rawResult: providerResult.result,
        redactValues,
      };
    } catch (caught) {
      const endedAt = new Date();
      const error = caught instanceof Error ? caught : new Error(String(caught));
      const providerError = error instanceof DataLifecycleProviderError ? error : undefined;
      const redactValues = combineRedactValues(inheritedRedactValues, providerError?.redactValues);
      return {
        operationResult: {
          id: operationId,
          phase,
          environment: this.result.environment,
          provider: this.environment.provider,
          transport: "transport" in this.environment ? this.environment.transport : undefined,
          kind: operation.kind,
          function: operation.function,
          status: "failed",
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          durationMs: Math.max(0, endedAt.getTime() - startedAt.getTime()),
          ...(resolvedArgs === undefined
            ? {}
            : {
                args: redactSensitiveValue(resolvedArgs, {
                  extraKeys: operation.redactKeys,
                  extraValues: redactValues,
                }),
              }),
          ...(providerError?.result === undefined
            ? {}
            : {
                result: redactSensitiveValue(providerError.result, {
                  extraKeys: operation.redactKeys,
                  extraValues: redactValues,
                }),
              }),
          ...(providerError?.stdout
            ? { stdout: redactSensitiveText(providerError.stdout, { extraValues: redactValues }) }
            : {}),
          ...(providerError?.stderr
            ? { stderr: redactSensitiveText(providerError.stderr, { extraValues: redactValues }) }
            : {}),
          ...(providerError?.exitCode === undefined ? {} : { exitCode: providerError.exitCode }),
          ...(providerError?.signal ? { signal: providerError.signal } : {}),
          ...(providerError?.httpStatus === undefined ? {} : { httpStatus: providerError.httpStatus }),
          error: {
            message: redactSensitiveText(error.message, { extraValues: redactValues }),
            stack: error.stack
              ? redactSensitiveText(error.stack, { extraValues: redactValues })
              : undefined,
            classification: classifyError(error),
          },
        },
      };
    }
  }

  private captureManifest(
    operation: DataLifecycleOperation,
    result: unknown,
    redactValues: string[] = [],
  ): void {
    const selected =
      operation.manifestPath === undefined ? result : selectJsonPath(result, operation.manifestPath);
    this.manifest = selected;
    this.manifestRedactValues = redactValues;
    this.result.manifest = redactSensitiveValue(selected, {
      extraKeys: operation.redactKeys,
      extraValues: redactValues,
    });
  }

  private async writePhaseArtifact(
    phase: DataLifecyclePhase,
    status: DataLifecycleExecution["status"],
  ): Promise<void> {
    const artifactPath = this.result.artifacts[phase];
    if (!artifactPath) {
      throw new Error(`No data lifecycle artifact path configured for phase "${phase}".`);
    }

    await mkdir(this.options.runDir, { recursive: true });
    await writeFile(
      artifactPath,
      `${JSON.stringify(
        {
          schemaVersion: "0.1",
          scope: this.options.scope,
          environment: this.result.environment,
          namespace: this.result.namespace,
          phase,
          status,
          manifest: this.result.manifest,
          suiteManifest: this.result.suiteManifest,
          operations: this.result[phase],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
}

function operationsForPhase(
  definition: DataLifecycleDefinition,
  phase: DataLifecyclePhase,
): DataLifecycleOperation[] {
  return definition[phase] ?? [];
}

function operationAllowFailure(
  operations: DataLifecycleOperation[],
  result: DataLifecycleOperationResult,
): boolean {
  const operation = operations.find(
    (candidate, index) => (candidate.id ?? `${result.phase}-${index + 1}`) === result.id,
  );
  return operation?.allowFailure ?? false;
}

function assertCapabilities(
  environment: DataEnvironment,
  operation: DataLifecycleOperation,
): void {
  const requested = operation.requiredCapabilities ?? [];
  if (requested.length === 0) {
    return;
  }

  const defaults =
    environment.provider === "convex" && environment.transport === "cli"
      ? { publicFunctions: true, internalFunctions: true }
      : { publicFunctions: true, internalFunctions: false };
  const capabilities = { ...defaults, ...(environment.capabilities ?? {}) };

  for (const capability of requested) {
    if (!capabilities[capability]) {
      throw new Error(
        `Data lifecycle operation "${operation.function}" requires capability "${capability}", but environment does not declare it.`,
      );
    }
  }
}

function extractChecks(result: unknown): DataLifecycleCheck[] | undefined {
  if (!isRecord(result) || !Array.isArray(result.checks)) {
    return undefined;
  }

  return result.checks.map((raw, index) => {
    if (!isRecord(raw)) {
      return {
        id: `check-${index + 1}`,
        status: "fail",
        message: "Check result was not an object.",
        data: raw,
      };
    }

    const status = raw.status === "pass" || raw.status === "warn" || raw.status === "fail"
      ? raw.status
      : "fail";

    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : `check-${index + 1}`,
      status,
      ...(typeof raw.message === "string" && raw.message ? { message: raw.message } : {}),
      ...("data" in raw ? { data: raw.data } : {}),
    };
  });
}

function assertionFailureMessage(checks: DataLifecycleCheck[] | undefined): string {
  const failures = checks
    ?.filter((check) => check.status === "fail")
    .map((check) => `${check.id}${check.message ? `: ${check.message}` : ""}`);
  return failures && failures.length > 0
    ? `Data lifecycle checks failed: ${failures.join("; ")}`
    : "Data lifecycle checks failed.";
}

function combineRedactValues(
  inherited: string[] = [],
  current: string[] = [],
): string[] {
  return [...new Set([...inherited, ...current].filter((value) => value.length > 0))];
}

function resolveTemplate(
  value: unknown,
  sources: {
    context: Record<string, unknown>;
    manifest?: unknown;
    suiteManifest?: unknown;
    env: NodeJS.ProcessEnv;
  },
): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    return resolveReference(value, sources);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplate(item, sources));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveTemplate(entry, sources)]),
    );
  }
  return value;
}

function resolveReference(
  value: string,
  sources: {
    context: Record<string, unknown>;
    manifest?: unknown;
    suiteManifest?: unknown;
    env: NodeJS.ProcessEnv;
  },
): unknown {
  if (value === "$manifest") {
    return sources.manifest;
  }
  if (value.startsWith("$manifest.")) {
    return selectJsonPath(sources.manifest, value.replace("$manifest", "$"));
  }
  if (value === "$suiteManifest") {
    return sources.suiteManifest;
  }
  if (value.startsWith("$suiteManifest.")) {
    return selectJsonPath(sources.suiteManifest, value.replace("$suiteManifest", "$"));
  }
  if (value.startsWith("$context.")) {
    return selectJsonPath(sources.context, value.replace("$context", "$"));
  }
  if (value.startsWith("$env.")) {
    const key = value.slice("$env.".length);
    const resolved = sources.env[key];
    if (resolved === undefined) {
      throw new Error(`Environment variable "${key}" is not set.`);
    }
    return resolved;
  }

  throw new Error(`Unknown data lifecycle template reference "${value}".`);
}

export function selectJsonPath(value: unknown, path: string): unknown {
  const normalized = path.startsWith("$.") ? path.slice(2) : path.startsWith("$") ? path.slice(1) : path;
  if (!normalized) {
    return value;
  }

  let current = value;
  for (const segment of normalized.split(".")) {
    if (!segment) {
      continue;
    }

    const match = /^([^[\]]+)(?:\[(\d+)])?$/.exec(segment);
    if (!match) {
      throw new Error(`Unsupported JSON path segment "${segment}" in "${path}".`);
    }

    const key = match[1];
    if (!isRecord(current) && !Array.isArray(current)) {
      throw new Error(`Cannot resolve "${path}" because "${key}" is not reachable.`);
    }
    current = (current as Record<string, unknown>)[key];

    if (match[2] !== undefined) {
      if (!Array.isArray(current)) {
        throw new Error(`Cannot resolve "${path}" because "${key}" is not an array.`);
      }
      current = current[Number(match[2])];
    }
  }

  return current;
}

function classifyError(error: Error): "configuration" | "capability" | "execution" | "assertion" {
  if (error instanceof DataLifecycleProviderError && error.classification) {
    return error.classification;
  }
  if (/environment|configured|not set|JSON path|template/i.test(error.message)) {
    return "configuration";
  }
  if (/capability/i.test(error.message)) {
    return "capability";
  }
  return "execution";
}

function sanitizeNamespace(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "run";
}

function shortRunId(value: string): string {
  return sanitizeNamespace(value).slice(-12) || "run";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
