import { describe, expect, it } from "vitest";
import type { AgentVerdict, UserJourney } from "../src/core/schemas.js";
import { validateAgentVerdictForJourney } from "../src/core/validation.js";

const journey: UserJourney = {
  id: "sample",
  title: "Sample",
  app: {
    name: "Sample",
    baseUrl: "http://127.0.0.1:3000",
    allowedOrigins: ["http://127.0.0.1:3000"],
  },
  testerProfile: "admin",
  objective: "Complete the sample journey.",
  tasks: [{ id: "do-thing", instruction: "Do the thing." }],
  passCriteria: [
    {
      id: "pass",
      statement: "The thing is complete.",
      requiredEvidence: ["screenshot"],
    },
  ],
  failCriteria: [{ id: "fail", statement: "The thing cannot be completed." }],
  blockerCriteria: [{ id: "blocked", statement: "The app cannot load." }],
  riskLevel: "read-only",
};

describe("verdict validation", () => {
  it("requires every journey criterion to be assessed", () => {
    const verdict: AgentVerdict = {
      status: "passed",
      confidence: "high",
      summary: "Done.",
      criteria: [
        {
          id: "pass",
          result: "met",
          explanation: "Observed confirmation.",
          evidence: { screenshot: "shot.png" },
        },
      ],
      blockers: [],
      uxFindings: [],
      suggestedImprovements: [],
    };

    expect(validateAgentVerdictForJourney(journey, verdict)).toEqual([
      {
        path: "verdict.criteria.fail",
        message: 'Verdict did not assess criterion "fail".',
      },
      {
        path: "verdict.criteria.blocked",
        message: 'Verdict did not assess criterion "blocked".',
      },
    ]);
  });

  it("requires criterion evidence requested by the journey", () => {
    const verdict: AgentVerdict = {
      status: "passed",
      confidence: "high",
      summary: "Done.",
      criteria: [
        {
          id: "pass",
          result: "met",
          explanation: "Observed confirmation.",
        },
        {
          id: "fail",
          result: "not-met",
          explanation: "No failure observed.",
        },
        {
          id: "blocked",
          result: "not-met",
          explanation: "No blocker observed.",
        },
      ],
      blockers: [],
      uxFindings: [],
      suggestedImprovements: [],
    };

    expect(validateAgentVerdictForJourney(journey, verdict)).toEqual([
      {
        path: "verdict.criteria.pass.evidence",
        message: 'Criterion "pass" requires evidence "screenshot".',
      },
    ]);
  });

  it("requires console, network, and UI change timeline evidence references when requested", () => {
    const journeyWithRuntimeEvidence: UserJourney = {
      ...journey,
      passCriteria: [
        {
          ...journey.passCriteria[0],
          requiredEvidence: ["console", "network", "uiChangeTimeline"],
        },
      ],
    };
    const baseVerdict: AgentVerdict = {
      status: "passed",
      confidence: "high",
      summary: "Done.",
      criteria: [
        {
          id: "pass",
          result: "met",
          explanation: "Observed confirmation.",
        },
        {
          id: "fail",
          result: "not-met",
          explanation: "No failure observed.",
        },
        {
          id: "blocked",
          result: "not-met",
          explanation: "No blocker observed.",
        },
      ],
      blockers: [],
      uxFindings: [],
      suggestedImprovements: [],
    };

    expect(
      validateAgentVerdictForJourney(journeyWithRuntimeEvidence, baseVerdict),
    ).toEqual([
      {
        path: "verdict.criteria.pass.evidence",
        message: 'Criterion "pass" requires evidence "console".',
      },
      {
        path: "verdict.criteria.pass.evidence",
        message: 'Criterion "pass" requires evidence "network".',
      },
      {
        path: "verdict.criteria.pass.evidence",
        message: 'Criterion "pass" requires evidence "uiChangeTimeline".',
      },
    ]);

    expect(
      validateAgentVerdictForJourney(journeyWithRuntimeEvidence, {
        ...baseVerdict,
        criteria: [
          {
            id: "pass",
            result: "met",
            explanation: "Observed confirmation.",
            evidence: {
              console: "console/001-console.txt",
              network: "network/001-network.txt",
              uiChangeTimeline: "ui-changes/001-click.json",
            },
          },
          ...baseVerdict.criteria.slice(1),
        ],
      }),
    ).toEqual([]);
  });
});
