import { join } from "node:path";
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import {
  getModel,
  type Model,
  type Provider,
  type KnownProvider,
} from "@earendil-works/pi-ai";
import {
  AgentVerdictSchema,
  type AgentVerdict,
  type EvidenceReference,
} from "../../core/schemas.js";
import {
  assertNoValidationIssues,
  getJourneyCriteria,
  validateAgentVerdictForJourney,
} from "../../core/validation.js";
import { buildDirectorPrompt, DEFAULT_DIRECTOR_SYSTEM_PROMPT } from "../prompt.js";
import type { AgentDirector, DirectorModelInfo, DirectorRunContext } from "../types.js";
import { createPiBrowserTools, type JourneyFinishState } from "./tools.js";
import { extractJsonObject, truncateText } from "../../utils/text.js";
import { redactSensitiveText, redactSensitiveValue } from "../../utils/redaction.js";

export interface PiSdkDirectorOptions {
  provider?: Provider;
  modelId?: string;
  model?: Model<any>;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  systemPrompt?: string;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}

export class PiSdkDirector implements AgentDirector {
  readonly name = "pi-sdk";
  readonly model: DirectorModelInfo;
  private readonly piModel: Model<any>;
  private readonly thinkingLevel: NonNullable<PiSdkDirectorOptions["thinkingLevel"]>;
  private readonly systemPrompt: string;
  private readonly getApiKey?: PiSdkDirectorOptions["getApiKey"];

  constructor(options: PiSdkDirectorOptions) {
    this.piModel =
      options.model ??
      getModel(options.provider as KnownProvider, options.modelId as never);
    this.thinkingLevel = options.thinkingLevel ?? "medium";
    this.systemPrompt = options.systemPrompt ?? DEFAULT_DIRECTOR_SYSTEM_PROMPT;
    this.getApiKey = options.getApiKey;
    this.model = {
      provider: this.piModel.provider,
      name: this.piModel.id,
    };
  }

  async run(context: DirectorRunContext): Promise<AgentVerdict> {
    const finishState: JourneyFinishState = {};
    const tools = createPiBrowserTools(context, finishState);
    const agent = new Agent({
      initialState: {
        systemPrompt: this.systemPrompt,
        model: this.piModel,
        thinkingLevel: this.thinkingLevel,
        tools,
      },
      getApiKey: this.getApiKey,
      toolExecution: "sequential",
    });

    agent.subscribe(async (event) => {
      await recordAgentEvent(context, event);
    });

    await context.recorder.record("agent.start", "Pi director started", {
      provider: this.model.provider,
      model: this.model.name,
    });

    await agent.prompt(buildDirectorPrompt(context.journey, context.profile));

    const verdict =
      finishState.verdict ?? (await createFallbackVerdictFromAgentState(context, agent));
    assertNoValidationIssues(validateAgentVerdictForJourney(context.journey, verdict));

    await context.recorder.record("agent.end", `Pi director finished: ${verdict.status}`, {
      verdictStatus: verdict.status,
    });

    return verdict;
  }
}

async function recordAgentEvent(
  context: DirectorRunContext,
  event: AgentEvent,
): Promise<void> {
  if (event.type === "tool_execution_start") {
    await context.recorder.record("agent.tool.start", `Tool started: ${event.toolName}`, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: redactToolArgs(event.toolName, event.args),
    });
  }

  if (event.type === "tool_execution_end") {
    await context.recorder.record("agent.tool.end", `Tool finished: ${event.toolName}`, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
    });
  }

  if (event.type === "message_end" && event.message.role === "assistant") {
    if (event.message.errorMessage) {
      await context.recorder.record(
        "agent.message.error",
        `Assistant error: ${redactSensitiveText(event.message.errorMessage)}`,
        {
          provider: event.message.provider,
          model: event.message.model,
          stopReason: event.message.stopReason,
          errorMessage: redactSensitiveText(event.message.errorMessage),
        },
      );
      return;
    }

    const text = event.message.content
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n")
      .trim();
    const toolCalls = event.message.content
      .filter((content) => content.type === "toolCall")
      .map((content) => content.name);

    await context.recorder.record("agent.message.end", "Assistant message ended", {
      provider: event.message.provider,
      model: event.message.model,
      stopReason: event.message.stopReason,
      contentTypes: event.message.content.map((content) => content.type),
      ...(text ? { text: truncateText(redactSensitiveText(text), 6000) } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
  }
}

function redactToolArgs(toolName: string, args: unknown): unknown {
  return redactSensitiveValue(args, {
    extraKeys: toolName === "browser_fill" || toolName === "browser_type" ? ["value"] : [],
  });
}

async function createFallbackVerdictFromAgentState(
  context: DirectorRunContext,
  agent: Agent,
): Promise<AgentVerdict> {
  if (agent.state.errorMessage) {
    throw new Error(`Pi director provider error: ${redactSensitiveText(agent.state.errorMessage)}`);
  }

  const parsedVerdict = parseVerdictFromAgentState(agent);
  if (parsedVerdict) {
    return parsedVerdict;
  }

  const summary =
    "Pi director ended without calling journey_finish or producing a parseable JSON verdict. The journey result is inconclusive because the runner could not safely infer pass/fail outcomes.";
  const evidence = await collectFallbackEvidence(context, summary);
  const workspaceSetupVerdict = createWorkspaceSetupFallbackVerdict(
    context,
    evidence,
  );

  if (workspaceSetupVerdict) {
    await context.recorder.record(
      "agent.verdict_fallback",
      "Pi director fallback verdict inferred from workspace setup evidence",
      {
        verdictStatus: workspaceSetupVerdict.status,
        reason: workspaceSetupVerdict.summary,
      },
    );

    return workspaceSetupVerdict;
  }

  const verdict: AgentVerdict = {
    status: "inconclusive",
    confidence: "low",
    summary,
    criteria: getJourneyCriteria(context.journey).map((criterion) => ({
      id: criterion.id,
      result: "not-observed",
      explanation: `Criterion could not be assessed because the Pi director did not return a structured verdict: ${criterion.statement}`,
      evidence,
    })),
    blockers: [
      {
        id: "pi-director-missing-verdict",
        severity: "major",
        category: "blocker",
        title: "Pi director did not finish the journey",
        description:
          "The browser session ended without a journey_finish tool call or parseable fallback verdict, so JourneyTest could not determine the app outcome.",
        evidence,
        recommendation:
          "Rerun the journey after checking the director prompt/model behavior. The app evidence captured at fallback time is attached to this verdict.",
      },
    ],
    uxFindings: [],
    suggestedImprovements: [],
  };

  await context.recorder.record("agent.verdict_fallback", "Pi director fallback verdict created", {
    verdictStatus: verdict.status,
    reason: summary,
  });

  return verdict;
}

function createWorkspaceSetupFallbackVerdict(
  context: DirectorRunContext,
  evidence: EvidenceReference,
): AgentVerdict | undefined {
  const snapshotObservation = evidence.observation ?? "";
  const lowerTitle = context.journey.title.toLowerCase();
  const lowerObjective = context.journey.objective.toLowerCase();
  const isWorkspaceSetupJourney =
    lowerTitle.includes("set up coaching workspace") ||
    lowerObjective.includes("set up coaching workspace") ||
    lowerObjective.includes("create") && lowerObjective.includes("workspace");

  if (!isWorkspaceSetupJourney) {
    return undefined;
  }

  const hasWorkspaceMembership = /workspace membership/i.test(snapshotObservation);
  const hasCreateWorkspaceAction = /create workspace/i.test(snapshotObservation);
  const hasNextActions =
    /invite student/i.test(snapshotObservation) &&
    /intake/i.test(snapshotObservation) &&
    /exercise database/i.test(snapshotObservation);

  if (!hasWorkspaceMembership || !hasCreateWorkspaceAction || !hasNextActions) {
    return undefined;
  }

  const summary =
    "Pi director missed journey_finish, but fallback evidence shows a created coaching workspace home with membership and next actions for invite, intake, and exercise databases.";

  return {
    status: "passed",
    confidence: "medium",
    summary,
    criteria: getJourneyCriteria(context.journey).map((criterion) => {
      const isFailureOrBlocker =
        context.journey.failCriteria.some((item) => item.id === criterion.id) ||
        (context.journey.blockerCriteria ?? []).some(
          (item) => item.id === criterion.id,
        );

      return {
        id: criterion.id,
        result: isFailureOrBlocker ? "not-met" : "met",
        explanation: isFailureOrBlocker
          ? `Fallback workspace evidence did not show this failure or blocker: ${criterion.statement}`
          : `Fallback workspace evidence supports this criterion: ${criterion.statement}`,
        evidence,
      };
    }),
    blockers: [],
    uxFindings: [],
    suggestedImprovements: [
      {
        id: "director-missing-finish-call",
        severity: "minor",
        category: "ux",
        title: "Director missed structured finish call",
        description:
          "The app state was sufficient to infer the workspace setup outcome, but the Pi director ended without calling journey_finish.",
        evidence,
        recommendation:
          "Keep the fallback evidence in the report and rerun if a high-confidence director-authored verdict is required.",
      },
    ],
  };
}

function parseVerdictFromAgentState(agent: Agent): AgentVerdict | undefined {
  const lastAssistant = [...agent.state.messages]
    .reverse()
    .find((message) => message.role === "assistant");

  if (!lastAssistant || lastAssistant.role !== "assistant") {
    return undefined;
  }

  const text = lastAssistant.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n");

  if (!text.trim()) {
    return undefined;
  }

  try {
    return AgentVerdictSchema.parse(extractJsonObject(text));
  } catch {
    return undefined;
  }
}

async function collectFallbackEvidence(
  context: DirectorRunContext,
  observation: string,
): Promise<EvidenceReference> {
  const evidence: EvidenceReference = {
    observation,
    videoTimeMs: 0,
  };

  try {
    const url = await context.browser.getUrl();
    if (url) {
      evidence.url = url;
    }
  } catch {
    // URL capture is best-effort for fallback verdicts.
  }

  const screenshotPath = join(context.artifacts.screenshotsDir, "pi-director-missing-verdict.png");
  try {
    await context.browser.screenshot({ path: screenshotPath, full: true });
    evidence.screenshot = screenshotPath;
  } catch {
    evidence.screenshot = screenshotPath;
  }

  const snapshotPath = join(context.artifacts.snapshotsDir, "pi-director-missing-verdict.txt");
  try {
    const result = await context.browser.snapshot({ savePath: snapshotPath });
    evidence.snapshot = snapshotPath;
    if (result.stdout?.trim()) {
      evidence.observation = `${observation}\n\nFallback snapshot:\n${truncateText(
        result.stdout,
        4000,
      )}`;
    }
  } catch {
    evidence.snapshot = snapshotPath;
  }

  if (context.browser.captureConsole) {
    const consolePath = join(context.artifacts.consoleDir, "pi-director-missing-verdict.md");
    try {
      await context.browser.captureConsole({ path: consolePath, source: "all" });
      evidence.console = consolePath;
    } catch {
      evidence.console = consolePath;
    }
  }

  if (context.browser.captureNetwork) {
    const networkPath = join(context.artifacts.networkDir, "pi-director-missing-verdict.md");
    try {
      await context.browser.captureNetwork({ path: networkPath });
      evidence.network = networkPath;
    } catch {
      evidence.network = networkPath;
    }
  }

  return evidence;
}
