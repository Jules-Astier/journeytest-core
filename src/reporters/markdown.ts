import type {
  AgentVerdict,
  DataLifecycleExecution,
  DataLifecycleOperationResult,
  Finding,
  RunResult,
} from "../core/schemas.js";

export function renderMarkdownReport(result: RunResult): string {
  const lines: string[] = [];
  lines.push(`# JourneyTest Report: ${result.journeyId}`);
  lines.push("");
  lines.push(`- Run: \`${result.runId}\``);
  lines.push(`- Run status: \`${result.runStatus}\``);
  lines.push(`- Started: ${result.startedAt}`);
  lines.push(`- Ended: ${result.endedAt}`);
  lines.push(`- Duration: ${result.durationMs}ms`);
  if (result.model) {
    lines.push(`- Model: ${result.model.provider}/${result.model.name}`);
  }
  if (result.dataLifecycle) {
    lines.push(`- Data lifecycle: \`${result.dataLifecycle.status}\``);
  }
  if (result.browserEnvironment) {
    lines.push(
      `- Browser environment: ${formatBrowserEnvironment(result.browserEnvironment)}`,
    );
  }
  if (result.artifacts.video) {
    lines.push(`- Video: ${result.artifacts.video}`);
  }
  lines.push("");

  if (result.error) {
    lines.push("## Error");
    lines.push("");
    lines.push(result.error.message);
    lines.push("");
  }

  if (result.verdict) {
    appendVerdict(lines, result.verdict);
  }

  if (result.dataLifecycle) {
    appendDataLifecycle(lines, result.dataLifecycle);
  }

  lines.push("## Artifacts");
  lines.push("");
  lines.push(`- Events: ${result.artifacts.events}`);
  lines.push(`- Dashboard: ${result.artifacts.dashboard}`);
  lines.push(`- Result JSON: ${result.artifacts.result}`);
  lines.push(`- Report: ${result.artifacts.report}`);
  for (const screenshot of result.artifacts.screenshots) {
    lines.push(`- Screenshot: ${screenshot}`);
  }
  for (const snapshot of result.artifacts.snapshots) {
    lines.push(`- Snapshot: ${snapshot}`);
  }
  for (const consoleArtifact of result.artifacts.console ?? []) {
    lines.push(`- Console: ${consoleArtifact}`);
  }
  for (const networkArtifact of result.artifacts.network ?? []) {
    lines.push(`- Network: ${networkArtifact}`);
  }
  for (const uiChangeArtifact of result.artifacts.uiChanges ?? []) {
    lines.push(`- UI changes: ${uiChangeArtifact}`);
  }
  if (result.artifacts.dataLifecycle) {
    for (const [phase, path] of Object.entries(
      result.artifacts.dataLifecycle,
    )) {
      if (path) {
        lines.push(`- Data lifecycle ${phase}: ${path}`);
      }
    }
  }
  lines.push("");

  lines.push("## Timeline");
  lines.push("");
  lines.push("| Time | Video | Type | Summary |");
  lines.push("| --- | ---: | --- | --- |");
  for (const event of result.timeline) {
    lines.push(
      `| ${event.elapsedMs}ms | ${event.videoTimeMs ?? ""} | ${escapeCell(event.type)} | ${escapeCell(event.summary)} |`,
    );
  }
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function formatBrowserEnvironment(
  environment: NonNullable<RunResult["browserEnvironment"]>,
): string {
  const parts = [
    environment.device ? `device \`${environment.device}\`` : undefined,
    environment.viewport
      ? `viewport \`${environment.viewport.width}x${environment.viewport.height}${
          environment.viewport.deviceScaleFactor === undefined
            ? ""
            : `@${environment.viewport.deviceScaleFactor}`
        }\``
      : undefined,
  ].filter(Boolean);

  return parts.join("; ");
}

function appendDataLifecycle(
  lines: string[],
  lifecycle: DataLifecycleExecution,
): void {
  lines.push("## Data Lifecycle");
  lines.push("");
  lines.push(`- Scope: \`${lifecycle.scope}\``);
  lines.push(`- Environment: \`${lifecycle.environment}\``);
  lines.push(`- Namespace: \`${lifecycle.namespace}\``);
  lines.push(`- Status: \`${lifecycle.status}\``);
  lines.push("");

  for (const [title, operations] of [
    ["Setup", lifecycle.setup],
    ["Preflight", lifecycle.preflight],
    ["Postconditions", lifecycle.postconditions],
    ["Cleanup", lifecycle.cleanup],
  ] as const) {
    lines.push(`### ${title}`);
    lines.push("");
    appendLifecycleOperations(lines, operations);
  }
}

function appendLifecycleOperations(
  lines: string[],
  operations: DataLifecycleOperationResult[],
): void {
  if (operations.length === 0) {
    lines.push("No operations.");
    lines.push("");
    return;
  }

  lines.push("| Operation | Function | Status | Checks | Error |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const operation of operations) {
    lines.push(
      `| ${escapeCell(operation.id)} | ${escapeCell(operation.function)} | ${operation.status} | ${escapeCell(formatLifecycleChecks(operation))} | ${escapeCell(operation.error?.message ?? "")} |`,
    );
  }
  lines.push("");
}

function formatLifecycleChecks(
  operation: DataLifecycleOperationResult,
): string {
  if (!operation.checks || operation.checks.length === 0) {
    return "";
  }

  return operation.checks
    .map(
      (check) =>
        `${check.status}:${check.id}${check.message ? ` ${check.message}` : ""}`,
    )
    .join("; ");
}

function appendVerdict(lines: string[], verdict: AgentVerdict): void {
  lines.push("## Verdict");
  lines.push("");
  lines.push(`- Status: \`${verdict.status}\``);
  lines.push(`- Confidence: \`${verdict.confidence}\``);
  lines.push(`- Summary: ${verdict.summary}`);
  lines.push("");

  lines.push("### Criteria");
  lines.push("");
  lines.push("| Criterion | Result | Evidence | Explanation |");
  lines.push("| --- | --- | --- | --- |");
  for (const criterion of verdict.criteria) {
    lines.push(
      `| ${escapeCell(criterion.id)} | ${criterion.result} | ${escapeCell(formatEvidence(criterion.evidence))} | ${escapeCell(criterion.explanation)} |`,
    );
  }
  lines.push("");

  appendFindings(lines, "Blockers", verdict.blockers);
  appendFindings(lines, "UX Findings", verdict.uxFindings);
  appendFindings(
    lines,
    "Suggested Improvements",
    verdict.suggestedImprovements,
  );
}

function appendFindings(
  lines: string[],
  title: string,
  findings: Finding[],
): void {
  lines.push(`### ${title}`);
  lines.push("");
  if (findings.length === 0) {
    lines.push("None.");
    lines.push("");
    return;
  }

  for (const finding of findings) {
    lines.push(
      `- **${finding.severity}/${finding.category}: ${finding.title}**`,
    );
    lines.push(`  ${finding.description}`);
    if (finding.recommendation) {
      lines.push(`  Recommendation: ${finding.recommendation}`);
    }
    if (finding.evidence) {
      lines.push(`  Evidence: ${formatEvidence(finding.evidence)}`);
    }
  }
  lines.push("");
}

function formatEvidence(
  evidence: AgentVerdict["criteria"][number]["evidence"],
): string {
  if (!evidence) {
    return "";
  }

  const parts = [
    evidence.videoTimeMs === undefined
      ? undefined
      : `video ${evidence.videoTimeMs}ms`,
    evidence.screenshot ? `screenshot ${evidence.screenshot}` : undefined,
    evidence.snapshot ? `snapshot ${evidence.snapshot}` : undefined,
    evidence.url ? `url ${evidence.url}` : undefined,
    evidence.observation ? `observation ${evidence.observation}` : undefined,
    evidence.console ? `console ${evidence.console}` : undefined,
    evidence.network ? `network ${evidence.network}` : undefined,
    evidence.uiChangeTimeline
      ? `uiChangeTimeline ${evidence.uiChangeTimeline}`
      : undefined,
  ].filter(Boolean);

  return parts.join("; ");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
