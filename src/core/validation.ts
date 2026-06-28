import type {
  AgentVerdict,
  EvidenceKind,
  JourneyCriterion,
  TesterProfile,
  UserJourney,
} from "./schemas.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export function validateJourneyProfileMatch(
  journey: UserJourney,
  profile: TesterProfile,
): ValidationIssue[] {
  if (journey.testerProfile !== profile.id) {
    return [
      {
        path: "testerProfile",
        message: `Journey expects tester profile "${journey.testerProfile}" but received "${profile.id}".`,
      },
    ];
  }

  return [];
}

export function validateAllowedOrigins(
  journey: UserJourney,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const baseOrigin = new URL(journey.app.baseUrl).origin;
  const allowedOrigins = journey.app.allowedOrigins ?? [baseOrigin];

  if (!allowedOrigins.includes(baseOrigin)) {
    issues.push({
      path: "app.allowedOrigins",
      message: `allowedOrigins must include baseUrl origin "${baseOrigin}".`,
    });
  }

  return issues;
}

export function getJourneyCriteria(journey: UserJourney): JourneyCriterion[] {
  return [
    ...journey.passCriteria,
    ...journey.failCriteria,
    ...(journey.blockerCriteria ?? []),
  ];
}

export function validateAgentVerdictForJourney(
  journey: UserJourney,
  verdict: AgentVerdict,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const criteria = getJourneyCriteria(journey);
  const criteriaById = new Map(
    criteria.map((criterion) => [criterion.id, criterion]),
  );
  const assessmentsById = new Map(
    verdict.criteria.map((item) => [item.id, item]),
  );

  for (const assessment of verdict.criteria) {
    if (!criteriaById.has(assessment.id)) {
      issues.push({
        path: `verdict.criteria.${assessment.id}`,
        message: `Verdict assessed unknown criterion "${assessment.id}".`,
      });
    }
  }

  for (const criterion of criteria) {
    const assessment = assessmentsById.get(criterion.id);
    if (!assessment) {
      issues.push({
        path: `verdict.criteria.${criterion.id}`,
        message: `Verdict did not assess criterion "${criterion.id}".`,
      });
      continue;
    }

    for (const evidenceKind of criterion.requiredEvidence ?? []) {
      if (!assessmentIncludesEvidence(assessment.evidence, evidenceKind)) {
        issues.push({
          path: `verdict.criteria.${criterion.id}.evidence`,
          message: `Criterion "${criterion.id}" requires evidence "${evidenceKind}".`,
        });
      }
    }
  }

  return issues;
}

function assessmentIncludesEvidence(
  evidence: AgentVerdict["criteria"][number]["evidence"],
  kind: EvidenceKind,
): boolean {
  if (kind === "agentObservation") {
    return Boolean(evidence?.observation);
  }
  if (kind === "screenshot") {
    return Boolean(evidence?.screenshot);
  }
  if (kind === "snapshot") {
    return Boolean(evidence?.snapshot);
  }
  if (kind === "url") {
    return Boolean(evidence?.url);
  }
  if (kind === "videoTimestamp") {
    return typeof evidence?.videoTimeMs === "number";
  }
  if (kind === "console") {
    return Boolean(evidence?.console);
  }
  if (kind === "network") {
    return Boolean(evidence?.network);
  }
  if (kind === "uiChangeTimeline") {
    return Boolean(evidence?.uiChangeTimeline);
  }

  return false;
}

export function assertNoValidationIssues(issues: ValidationIssue[]): void {
  if (issues.length === 0) {
    return;
  }

  const details = issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("\n");
  throw new Error(`Validation failed:\n${details}`);
}
