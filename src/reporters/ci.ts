import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  DataLifecycleExecution,
  DataLifecycleOperationResult,
  Finding,
  RunArtifacts,
  RunResult,
} from "../core/schemas.js";

export interface CiReportRun {
  journeyFile?: string;
  result: RunResult;
}

export type CiRunStatus =
  | "passed"
  | "failed"
  | "blocked"
  | "inconclusive"
  | "error"
  | "cancelled";

export interface CiRunSummary {
  journeyId: string;
  runId: string;
  journeyFile?: string;
  status: CiRunStatus;
  message: string;
  runStatus: RunResult["runStatus"];
  verdictStatus?: NonNullable<RunResult["verdict"]>["status"];
  dataLifecycleStatus?: DataLifecycleExecution["status"];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  artifacts: RunArtifacts;
  error?: RunResult["error"];
}

export interface CiSummaryJson {
  schemaVersion: "0.1";
  generatedAt: string;
  total: number;
  counts: Record<CiRunStatus, number>;
  runs: CiRunSummary[];
}

export interface RenderCiReportOptions {
  runs: CiReportRun[];
  generatedAt?: string;
  suiteName?: string;
}

export interface WriteCiReportsOptions extends RenderCiReportOptions {
  junitPath?: string;
  summaryJsonPath?: string;
}

const ciStatuses: CiRunStatus[] = [
  "passed",
  "failed",
  "blocked",
  "inconclusive",
  "error",
  "cancelled",
];

interface CiCase extends CiRunSummary {
  details: string;
}

export async function writeCiReports(
  options: WriteCiReportsOptions,
): Promise<{ junitPath?: string; summaryJsonPath?: string }> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const written: { junitPath?: string; summaryJsonPath?: string } = {};

  if (options.junitPath) {
    await writeTextFile(
      options.junitPath,
      renderJUnitXml({ ...options, generatedAt }),
    );
    written.junitPath = options.junitPath;
  }

  if (options.summaryJsonPath) {
    await writeTextFile(
      options.summaryJsonPath,
      renderSummaryJson({ ...options, generatedAt }),
    );
    written.summaryJsonPath = options.summaryJsonPath;
  }

  return written;
}

export function renderJUnitXml(options: RenderCiReportOptions): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const suiteName = options.suiteName ?? "JourneyTest";
  const cases = createCiCases(options.runs);
  const failures = cases.filter((testCase) => testCase.status === "failed").length;
  const errors = cases.filter((testCase) =>
    testCase.status === "error" || testCase.status === "cancelled",
  ).length;
  const skipped = cases.filter((testCase) =>
    testCase.status === "blocked" || testCase.status === "inconclusive",
  ).length;
  const time = seconds(cases.reduce((sum, testCase) => sum + testCase.durationMs, 0));

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${escapeXmlAttribute(suiteName)}" tests="${cases.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time}" timestamp="${escapeXmlAttribute(generatedAt)}">`,
    ...cases.map((testCase) => renderJUnitTestCase(testCase, suiteName)),
    "</testsuite>",
    "",
  ].join("\n");
}

export function renderSummaryJson(options: RenderCiReportOptions): string {
  return `${JSON.stringify(createSummaryJson(options), null, 2)}\n`;
}

export function createSummaryJson(options: RenderCiReportOptions): CiSummaryJson {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const cases = createCiCases(options.runs);
  const counts = Object.fromEntries(
    ciStatuses.map((status) => [
      status,
      cases.filter((testCase) => testCase.status === status).length,
    ]),
  ) as Record<CiRunStatus, number>;

  return {
    schemaVersion: "0.1",
    generatedAt,
    total: cases.length,
    counts,
    runs: cases.map(({ details: _details, ...testCase }) => testCase),
  };
}

export function renderGitHubAnnotations(runs: CiReportRun[]): string[] {
  return createCiCases(runs)
    .filter((testCase) => testCase.status !== "passed")
    .map(formatGitHubAnnotation);
}

export function emitGitHubAnnotations(
  runs: CiReportRun[],
  stream: NodeJS.WritableStream = process.stderr,
): void {
  for (const annotation of renderGitHubAnnotations(runs)) {
    stream.write(`${annotation}\n`);
  }
}

function createCiCases(runs: CiReportRun[]): CiCase[] {
  return runs.map((run) => {
    const classification = classifyRun(run.result);
    const summary: CiRunSummary = {
      journeyId: run.result.journeyId,
      runId: run.result.runId,
      ...(run.journeyFile ? { journeyFile: run.journeyFile } : {}),
      status: classification.status,
      message: classification.message,
      runStatus: run.result.runStatus,
      ...(run.result.verdict?.status ? { verdictStatus: run.result.verdict.status } : {}),
      ...(run.result.dataLifecycle?.status
        ? { dataLifecycleStatus: run.result.dataLifecycle.status }
        : {}),
      startedAt: run.result.startedAt,
      endedAt: run.result.endedAt,
      durationMs: run.result.durationMs,
      artifacts: run.result.artifacts,
      ...(run.result.error ? { error: run.result.error } : {}),
    };

    return {
      ...summary,
      details: formatCaseDetails(summary, run.result),
    };
  });
}

function classifyRun(result: RunResult): { status: CiRunStatus; message: string } {
  if (result.runStatus === "error") {
    return {
      status: "error",
      message: result.error?.message ?? "Journey run errored before a verdict was produced.",
    };
  }

  if (result.runStatus === "cancelled") {
    return {
      status: "cancelled",
      message: result.error?.message ?? "Journey run was cancelled.",
    };
  }

  if (result.runStatus === "blocked") {
    return {
      status: "blocked",
      message:
        result.error?.message ??
        dataLifecycleMessage(result.dataLifecycle) ??
        result.verdict?.summary ??
        "Journey run was blocked before completion.",
    };
  }

  if (result.dataLifecycle?.status === "blocked") {
    return {
      status: "blocked",
      message: dataLifecycleMessage(result.dataLifecycle) ?? "Data lifecycle blocked the run.",
    };
  }

  if (result.dataLifecycle?.status === "failed") {
    return {
      status: "failed",
      message: dataLifecycleMessage(result.dataLifecycle) ?? "Data lifecycle failed.",
    };
  }

  if (!result.verdict) {
    return {
      status: "inconclusive",
      message: "Journey completed without a verdict.",
    };
  }

  return {
    status: result.verdict.status,
    message: result.verdict.summary,
  };
}

function renderJUnitTestCase(testCase: CiCase, suiteName: string): string {
  const attrs = [
    ["classname", suiteName],
    ["name", testCase.journeyId],
    ["time", seconds(testCase.durationMs)],
    ["status", testCase.status],
    testCase.journeyFile ? ["file", testCase.journeyFile] : undefined,
  ].filter((attr): attr is [string, string] => Boolean(attr));
  const attrText = attrs
    .map(([key, value]) => `${key}="${escapeXmlAttribute(value)}"`)
    .join(" ");

  if (testCase.status === "passed") {
    return `  <testcase ${attrText} />`;
  }

  if (testCase.status === "failed") {
    return [
      `  <testcase ${attrText}>`,
      `    <failure type="failed" message="${escapeXmlAttribute(testCase.message)}">${escapeXmlText(testCase.details)}</failure>`,
      "  </testcase>",
    ].join("\n");
  }

  if (testCase.status === "error" || testCase.status === "cancelled") {
    return [
      `  <testcase ${attrText}>`,
      `    <error type="${testCase.status}" message="${escapeXmlAttribute(testCase.message)}">${escapeXmlText(testCase.details)}</error>`,
      "  </testcase>",
    ].join("\n");
  }

  return [
    `  <testcase ${attrText}>`,
    `    <skipped message="${escapeXmlAttribute(`${testCase.status}: ${testCase.message}`)}">${escapeXmlText(testCase.details)}</skipped>`,
    "  </testcase>",
  ].join("\n");
}

function formatGitHubAnnotation(testCase: CiCase): string {
  const level = testCase.status === "inconclusive" ? "warning" : "error";
  const properties = [
    ["file", testCase.journeyFile ?? testCase.artifacts.result],
    ["title", `JourneyTest ${testCase.status}: ${testCase.journeyId}`],
  ]
    .filter((property): property is [string, string] => Boolean(property[1]))
    .map(([key, value]) => `${key}=${escapeGitHubProperty(value)}`)
    .join(",");
  const message = [
    `${testCase.status.toUpperCase()}: ${testCase.message}`,
    `Run: ${testCase.runId}`,
    `Dashboard: ${testCase.artifacts.dashboard}`,
    `Report: ${testCase.artifacts.report}`,
  ].join("\n");

  return `::${level} ${properties}::${escapeGitHubMessage(message)}`;
}

function formatCaseDetails(summary: CiRunSummary, result: RunResult): string {
  const lines = [
    `Status: ${summary.status}`,
    `Journey: ${summary.journeyId}`,
    `Run: ${summary.runId}`,
    `Run status: ${result.runStatus}`,
  ];

  if (summary.journeyFile) {
    lines.push(`Source: ${summary.journeyFile}`);
  }
  if (result.verdict) {
    lines.push(`Verdict: ${result.verdict.status}`);
    lines.push(`Confidence: ${result.verdict.confidence}`);
    lines.push(`Summary: ${result.verdict.summary}`);
    appendCriteria(lines, result.verdict.criteria);
    appendFindings(lines, "Blockers", result.verdict.blockers);
    appendFindings(lines, "UX findings", result.verdict.uxFindings);
    appendFindings(lines, "Suggested improvements", result.verdict.suggestedImprovements);
  }
  if (result.dataLifecycle) {
    lines.push(`Data lifecycle: ${result.dataLifecycle.status}`);
    appendLifecycleFailures(lines, result.dataLifecycle);
  }
  if (result.error) {
    lines.push(`Error: ${result.error.message}`);
    if (result.error.stack) {
      lines.push(result.error.stack);
    }
  }

  lines.push(`Dashboard: ${result.artifacts.dashboard}`);
  lines.push(`Report: ${result.artifacts.report}`);
  lines.push(`Result: ${result.artifacts.result}`);

  return lines.join("\n");
}

function appendCriteria(
  lines: string[],
  criteria: NonNullable<RunResult["verdict"]>["criteria"],
): void {
  if (criteria.length === 0) {
    return;
  }

  lines.push("Criteria:");
  for (const criterion of criteria) {
    lines.push(`- ${criterion.id}: ${criterion.result} - ${criterion.explanation}`);
  }
}

function appendFindings(lines: string[], title: string, findings: Finding[]): void {
  if (findings.length === 0) {
    return;
  }

  lines.push(`${title}:`);
  for (const finding of findings) {
    lines.push(
      `- ${finding.severity}/${finding.category} ${finding.title}: ${finding.description}`,
    );
  }
}

function appendLifecycleFailures(
  lines: string[],
  lifecycle: DataLifecycleExecution,
): void {
  const failedOperations = lifecycleOperations(lifecycle).filter((operation) =>
    operation.status === "failed",
  );
  if (failedOperations.length === 0) {
    return;
  }

  lines.push("Data lifecycle failures:");
  for (const operation of failedOperations) {
    lines.push(`- ${formatOperationMessage(operation)}`);
  }
}

function dataLifecycleMessage(lifecycle: DataLifecycleExecution | undefined): string | undefined {
  if (!lifecycle || (lifecycle.status !== "failed" && lifecycle.status !== "blocked")) {
    return undefined;
  }

  const failedOperation = lifecycleOperations(lifecycle).find((operation) =>
    operation.status === "failed",
  );
  if (!failedOperation) {
    return `Data lifecycle ${lifecycle.status}.`;
  }

  return `Data lifecycle ${lifecycle.status}: ${formatOperationMessage(failedOperation)}`;
}

function lifecycleOperations(
  lifecycle: DataLifecycleExecution,
): DataLifecycleOperationResult[] {
  return [
    ...lifecycle.setup,
    ...lifecycle.preflight,
    ...lifecycle.postconditions,
    ...lifecycle.cleanup,
  ];
}

function formatOperationMessage(operation: DataLifecycleOperationResult): string {
  const checkFailures = operation.checks
    ?.filter((check) => check.status === "fail")
    .map((check) => `${check.id}${check.message ? ` ${check.message}` : ""}`)
    .join("; ");
  const reason = operation.error?.message ?? checkFailures;
  return [
    `${operation.phase}/${operation.id}`,
    operation.function,
    reason ? `failed: ${reason}` : operation.status,
  ].join(" ");
}

function seconds(durationMs: number): string {
  return (durationMs / 1000).toFixed(3);
}

function escapeXmlText(value: string): string {
  return normalizeXmlValue(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeXmlValue(value: string): string {
  return value.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd]/g, "");
}

function escapeGitHubMessage(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function escapeGitHubProperty(value: string): string {
  return escapeGitHubMessage(value)
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

async function writeTextFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}
