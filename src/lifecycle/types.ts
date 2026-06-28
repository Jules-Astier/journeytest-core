import type {
  DataEnvironment,
  DataLifecycleOperation,
  DataLifecycleOperationResult,
  DataLifecyclePhase,
  TesterProfile,
  UserJourney,
} from "../core/schemas.js";

export interface DataLifecycleProviderContext {
  scope: "suite" | "journey";
  runId: string;
  suiteRunId?: string;
  journeyRunId?: string;
  journey?: UserJourney;
  profile?: TesterProfile;
  namespace: string;
  manifest?: unknown;
  suiteManifest?: unknown;
  environmentName: string;
  environment: DataEnvironment;
  phase: DataLifecyclePhase;
  operation: DataLifecycleOperation;
  args?: unknown;
}

export type DataLifecycleFailureClassification =
  | "configuration"
  | "capability"
  | "execution"
  | "assertion";

export interface DataLifecycleProviderResult {
  result?: unknown;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: string;
  httpStatus?: number;
  redactValues?: string[];
}

export interface DataLifecycleProvider {
  readonly name: string;
  runOperation(
    context: DataLifecycleProviderContext,
  ): Promise<DataLifecycleProviderResult>;
}

export class DataLifecycleBlockedError extends Error {
  constructor(
    message: string,
    readonly results: DataLifecycleOperationResult[],
  ) {
    super(message);
    this.name = "DataLifecycleBlockedError";
  }
}

export interface DataLifecycleProviderErrorOptions {
  classification?: DataLifecycleFailureClassification;
  result?: unknown;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: string;
  httpStatus?: number;
  redactValues?: string[];
  cause?: unknown;
}

export class DataLifecycleProviderError extends Error {
  readonly classification?: DataLifecycleFailureClassification;
  readonly result?: unknown;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly httpStatus?: number;
  readonly redactValues: string[];

  constructor(message: string, options: DataLifecycleProviderErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "DataLifecycleProviderError";
    this.classification = options.classification;
    this.result = options.result;
    this.stdout = options.stdout;
    this.stderr = options.stderr;
    this.exitCode = options.exitCode;
    this.signal = options.signal;
    this.httpStatus = options.httpStatus;
    this.redactValues = options.redactValues ?? [];
  }
}
