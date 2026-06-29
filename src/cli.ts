#!/usr/bin/env node
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import {
  getOAuthApiKey,
  getOAuthProvider,
  getOAuthProviders,
  type OAuthCredentials,
} from "@earendil-works/pi-ai/oauth";
import {
  DataLifecycleConfigSchema,
  RunResultSchema,
  TesterProfileSchema,
  UserJourneySchema,
  type BrowserDevicePreset,
  type BrowserEnvironment,
  type RunAttempt,
  type RunResult,
  type TesterProfile,
  type UserJourney,
} from "./core/schemas.js";
import {
  DraftJourneyInputSchema,
  createDraftUserJourney,
  createJsonSchemaDocument,
  createTesterProfileTemplate,
  createUserJourneyTemplate,
  defaultAuthoringDir,
  formatLintIssue,
  initAuthoringProject,
  lintUserJourney,
  parseSchemaKind,
  stringifyJsonDocument,
  writeJsonDocument,
  type LintIssue,
  type SchemaKind,
} from "./core/authoring.js";
import { readAndParseJsonFile, readJsonFile } from "./core/json.js";
import {
  validateAllowedOrigins,
  validateJourneyProfileMatch,
  type ValidationIssue,
} from "./core/validation.js";
import { emitGitHubAnnotations, writeCiReports } from "./reporters/ci.js";
import {
  buildSuiteRunHistory,
  runHealth,
  snapshotRun,
  type RunSnapshot,
  type SuiteSelectionSummary,
  type SuiteRunHistory,
} from "./reporters/runComparison.js";
import {
  renderSuiteDashboard,
  type SuiteDashboardRun,
} from "./reporters/suiteDashboard.js";
import { runJourney, type RunJourneyOptions } from "./runner/runJourney.js";
import { isoTimestampForPath, sanitizePathSegment } from "./utils/path.js";
import {
  AppLifecycleController,
  applyAppTargetOverride,
  DataLifecycleController,
} from "./lifecycle/index.js";
import {
  createDefaultJourneyTestFactoryRegistry,
  type JourneyTestFactoryRegistry,
} from "./factories/index.js";
import type {
  AgentDirector,
  UiChangeRecordingOptions,
} from "./directors/types.js";
import type { BrowserDriver } from "./drivers/types.js";
import type { BookmarkCurator } from "./curation/types.js";

export interface RunCliOptions {
  factories?: JourneyTestFactoryRegistry;
}

export type ParallelBrowserMode = "shared-tabs" | "isolated-sessions";

const collectRepeatableOption = (value: string, previous: string[] = []): string[] => [
  ...previous,
  value,
];

export async function runCli(
  argv = process.argv,
  cliOptions: RunCliOptions = {},
): Promise<void> {
  const factories =
    cliOptions.factories ?? createDefaultJourneyTestFactoryRegistry();
  const program = new Command();

  program
    .name("journeytest")
    .description("AI-agent-directed user journey testing for web apps.")
    .version("0.1.0");

  program
    .command("init")
    .description("Create starter JourneyTest authoring files.")
    .option(
      "--dir <dir>",
      "Directory for generated authoring files.",
      defaultAuthoringDir,
    )
    .option(
      "--app-name <name>",
      "App name to use in generated journeys.",
      "Acme Admin",
    )
    .option(
      "--base-url <url>",
      "Base URL to use in generated journeys.",
      "http://127.0.0.1:3000",
    )
    .option("--profile-id <id>", "Tester profile id.", "admin")
    .option("--journey-id <id>", "Starter journey id.", "admin-invite-user")
    .option("--risk-level <level>", "Journey risk level.", "writes-test-data")
    .option("--force", "Overwrite files if they already exist.")
    .action(
      async (options: {
        dir: string;
        appName: string;
        baseUrl: string;
        profileId: string;
        journeyId: string;
        riskLevel: UserJourney["riskLevel"];
        force?: boolean;
      }) => {
        const result = await initAuthoringProject({
          rootDir: resolve(options.dir),
          appName: options.appName,
          baseUrl: options.baseUrl,
          profileId: options.profileId,
          id: options.journeyId,
          riskLevel: options.riskLevel,
          force: options.force,
        });
        console.log(`Wrote tester profile: ${result.profilePath}`);
        console.log(`Wrote user journey: ${result.journeyPath}`);
      },
    );

  const newCommand = program
    .command("new")
    .description("Generate JourneyTest authoring JSON.");

  newCommand
    .command("profile")
    .description("Generate a tester profile JSON file.")
    .argument("[id]", "Tester profile id.", "admin")
    .option("--name <name>", "Tester profile display name.")
    .option("--role <role>", "Tester role.")
    .option("--perspective <text>", "Tester perspective.")
    .option("--out <path>", "Output JSON path.")
    .option("--stdout", "Print JSON to stdout instead of writing a file.")
    .option("--force", "Overwrite the output file if it already exists.")
    .action(
      async (
        id: string,
        options: {
          name?: string;
          role?: string;
          perspective?: string;
          out?: string;
          stdout?: boolean;
          force?: boolean;
        },
      ) => {
        const profile = createTesterProfileTemplate({
          id,
          name: options.name,
          role: options.role,
          perspective: options.perspective,
        });
        if (options.stdout) {
          process.stdout.write(stringifyJsonDocument(profile));
          return;
        }

        const outPath = resolve(
          options.out ??
            join(defaultAuthoringDir, "profiles", `${profile.id}.json`),
        );
        await writeJsonDocument(outPath, profile, { force: options.force });
        console.log(`Wrote tester profile: ${outPath}`);
      },
    );

  newCommand
    .command("journey")
    .description("Generate a user journey JSON file.")
    .argument("[id]", "User journey id.", "admin-invite-user")
    .option("--title <title>", "Journey title.")
    .option("--profile <id>", "Tester profile id used by the journey.", "admin")
    .option("--app-name <name>", "App name.", "Acme Admin")
    .option("--base-url <url>", "App base URL.", "http://127.0.0.1:3000")
    .option("--risk-level <level>", "Journey risk level.", "writes-test-data")
    .option("--out <path>", "Output JSON path.")
    .option("--stdout", "Print JSON to stdout instead of writing a file.")
    .option("--force", "Overwrite the output file if it already exists.")
    .action(
      async (
        id: string,
        options: {
          title?: string;
          profile: string;
          appName: string;
          baseUrl: string;
          riskLevel: UserJourney["riskLevel"];
          out?: string;
          stdout?: boolean;
          force?: boolean;
        },
      ) => {
        const journey = createUserJourneyTemplate({
          id,
          title: options.title,
          appName: options.appName,
          baseUrl: options.baseUrl,
          testerProfile: options.profile,
          riskLevel: options.riskLevel,
        });
        if (options.stdout) {
          process.stdout.write(stringifyJsonDocument(journey));
          return;
        }

        const outPath = resolve(
          options.out ??
            join(defaultAuthoringDir, "journeys", `${journey.id}.json`),
        );
        await writeJsonDocument(outPath, journey, { force: options.force });
        console.log(`Wrote user journey: ${outPath}`);
      },
    );

  const draftCommand = program
    .command("draft")
    .description(
      "Draft richer JourneyTest authoring JSON from structured local inputs.",
    );

  draftCommand
    .command("journey")
    .description("Draft a user journey JSON file from flags or a JSON input file.")
    .argument("[id]", "User journey id.")
    .option("--input <path>", "JSON draft input file.")
    .option("--title <title>", "Journey title.")
    .option("--profile <id>", "Tester profile id used by the journey.")
    .option("--app-name <name>", "App name.")
    .option("--base-url <url>", "App base URL.")
    .option("--risk-level <level>", "Journey risk level.")
    .option("--objective <text>", "Journey objective.")
    .option(
      "--precondition <text>",
      "Precondition for the tester or environment. Repeatable.",
      collectRepeatableOption,
      [],
    )
    .option(
      "--task <instruction>",
      "Task instruction. Repeatable.",
      collectRepeatableOption,
      [],
    )
    .option(
      "--task-outcome <text>",
      "Expected outcome for the task at the same repeat index. Repeatable.",
      collectRepeatableOption,
      [],
    )
    .option(
      "--pass <statement>",
      "Pass criterion statement. Repeatable.",
      collectRepeatableOption,
      [],
    )
    .option(
      "--fail <statement>",
      "Fail criterion statement. Repeatable.",
      collectRepeatableOption,
      [],
    )
    .option(
      "--blocker <statement>",
      "Blocker criterion statement. Repeatable.",
      collectRepeatableOption,
      [],
    )
    .option(
      "--data <key=value>",
      "Journey data value. Repeatable. Values are parsed as JSON when possible.",
      collectRepeatableOption,
      [],
    )
    .option("--out <path>", "Output JSON path.")
    .option("--stdout", "Print JSON to stdout instead of writing a file.")
    .option("--force", "Overwrite the output file if it already exists.")
    .action(
      async (
        id: string | undefined,
        options: {
          input?: string;
          title?: string;
          profile?: string;
          appName?: string;
          baseUrl?: string;
          riskLevel?: UserJourney["riskLevel"];
          objective?: string;
          precondition: string[];
          task: string[];
          taskOutcome: string[];
          pass: string[];
          fail: string[];
          blocker: string[];
          data: string[];
          out?: string;
          stdout?: boolean;
          force?: boolean;
        },
      ) => {
        const input = options.input
          ? DraftJourneyInputSchema.parse(
              await readJsonFile(resolve(options.input)),
            )
          : undefined;
        const data = parseDataOptions(options.data);
        if (options.taskOutcome.length > options.task.length) {
          throw new Error(
            "--task-outcome cannot be provided more times than --task.",
          );
        }
        const tasks = options.task.map((instruction, index) => ({
          instruction,
          ...(options.taskOutcome[index]
            ? { expectedOutcome: options.taskOutcome[index] }
            : {}),
        }));
        const journey = createDraftUserJourney({
          input,
          id: id ?? input?.id,
          title: options.title,
          appName: options.appName,
          baseUrl: options.baseUrl,
          testerProfile: options.profile,
          riskLevel: options.riskLevel,
          objective: options.objective,
          preconditions:
            options.precondition.length > 0 ? options.precondition : undefined,
          ...(Object.keys(data).length > 0 ? { data } : {}),
          tasks: tasks.length > 0 ? tasks : undefined,
          passCriteria: options.pass.length > 0 ? options.pass : undefined,
          failCriteria: options.fail.length > 0 ? options.fail : undefined,
          blockerCriteria:
            options.blocker.length > 0 ? options.blocker : undefined,
        });
        if (options.stdout) {
          process.stdout.write(stringifyJsonDocument(journey));
          return;
        }

        const outPath = resolve(
          options.out ??
            join(defaultAuthoringDir, "journeys", `${journey.id}.json`),
        );
        await writeJsonDocument(outPath, journey, { force: options.force });
        console.log(`Wrote drafted user journey: ${outPath}`);
      },
    );

  program
    .command("schema")
    .description("Print JourneyTest authoring JSON schemas.")
    .argument("[kind]", "profile, journey, lifecycle, or all.", "all")
    .option("--out <path>", "Write schema JSON to a file.")
    .action(async (kindValue: string, options: { out?: string }) => {
      const kind: SchemaKind = parseSchemaKind(kindValue);
      const document = createJsonSchemaDocument(kind);
      if (options.out) {
        const outPath = resolve(options.out);
        await writeJsonDocument(outPath, document, { force: true });
        console.log(`Wrote schema: ${outPath}`);
        return;
      }

      process.stdout.write(stringifyJsonDocument(document));
    });

  program
    .command("lint")
    .description(
      "Lint JourneyTest authoring files for schema and quality issues.",
    )
    .requiredOption("--journeys <path>", "Journey JSON file or directory.")
    .option("--profiles <path>", "Tester profile JSON file or directory.")
    .action(async (options: { journeys: string; profiles?: string }) => {
      const result = await lintFiles(options.journeys, options.profiles);
      if (result.issueCount > 0) {
        process.exitCode = 1;
      }
    });

  program
    .command("validate")
    .description(
      "Validate JourneyTest user journey and tester profile JSON files.",
    )
    .requiredOption("--journeys <path>", "Journey JSON file or directory.")
    .requiredOption(
      "--profiles <path>",
      "Tester profile JSON file or directory.",
    )
    .action(async (options: { journeys: string; profiles: string }) => {
      const result = await validateFiles(options.journeys, options.profiles);
      if (result.issueCount > 0) {
        process.exitCode = 1;
      }
    });

  program
    .command("auth")
    .description("Inspect JourneyTest Pi OAuth authentication without printing secrets.")
    .option(
      "--auth <path>",
      "OAuth auth file. Defaults to JOURNEYTEST_AUTH_PATH, existing ./auth.json, then user config.",
    )
    .option("--json", "Print machine-readable JSON.")
    .action(async (options: { auth?: string; json?: boolean }) => {
      const authPath = await resolveAuthPath(options.auth);
      const status = await getOAuthAuthStatus(authPath);

      if (options.json) {
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        return;
      }

      console.log(`Auth file: ${status.path}`);
      console.log(`Source: ${authPathSourceLabel(status.source)}`);
      console.log(`Exists: ${status.exists ? "yes" : "no"}`);
      console.log(
        `Configured providers: ${
          status.configuredProviders.length > 0
            ? status.configuredProviders.join(", ")
            : "none"
        }`,
      );
      console.log(
        `Pi OAuth providers: ${
          status.availableOAuthProviders.length > 0
            ? status.availableOAuthProviders.join(", ")
            : "none"
        }`,
      );

      const unknown = status.configuredProviders.filter(
        (provider) => !status.availableOAuthProviders.includes(provider),
      );
      if (unknown.length > 0) {
        console.log(
          `Configured but not registered by this Pi version: ${unknown.join(", ")}`,
        );
      }
    });

  program
    .command("run")
    .description(
      "Run one JourneyTest user journey file, or all journey JSON files under a directory.",
    )
    .argument("<journeys>", "Journey JSON file or directory.")
    .option("--profile <path>", "Tester profile JSON file or directory.")
    .option("--profiles <path>", "Tester profile JSON file or directory.")
    .option("--out <dir>", "Output directory.", "runs")
    .option("--director <name>", "Agent director factory to use.", "pi")
    .option(
      "--browser <name>",
      "Browser driver factory to use.",
      "agent-browser",
    )
    .option("--provider <provider>", "Pi model provider.", "anthropic")
    .requiredOption("--model <model>", "Pi model id.")
    .option(
      "--auth <path>",
      "OAuth auth file. Defaults to JOURNEYTEST_AUTH_PATH, existing ./auth.json, then user config.",
    )
    .option("--session <name>", "agent-browser session name.")
    .option("--state <path>", "agent-browser state file.")
    .option("--headed", "Run browser headed.")
    .option(
      "--viewport <width>x<height>",
      "Set browser viewport size, for example 1440x900.",
    )
    .option(
      "--device <preset>",
      "Set a curated browser device preset: iphone-14, pixel-7, or ipad-pro-11.",
    )
    .option(
      "--parallel-agents <count>",
      "Number of user journeys to run in parallel.",
      "1",
    )
    .option(
      "--parallel-browser-mode <mode>",
      "Browser strategy for parallel agent-browser runs: shared-tabs or isolated-sessions.",
      "shared-tabs",
    )
    .option(
      "--retries <count>",
      "Retry each journey up to this many times after a failing attempt.",
      "0",
    )
    .option(
      "--journey-timeout-ms <ms>",
      "Maximum wall-clock time for one journey director run before it is aborted.",
      "1800000",
    )
    .option("--no-video", "Disable video recording.")
    .option(
      "--no-ui-change-recording",
      "Disable automatic UI change timelines around browser actions.",
    )
    .option(
      "--ui-change-timeout-ms <ms>",
      "Maximum time to watch for UI changes after each browser action.",
    )
    .option(
      "--ui-change-quiet-ms <ms>",
      "Quiet window before ending UI change observation after changes are seen.",
    )
    .option(
      "--ui-change-max-changes <count>",
      "Maximum UI change records to keep per browser action.",
    )
    .option(
      "--ui-change-max-screenshots <count>",
      "Maximum change screenshots to keep per browser action.",
    )
    .option(
      "--no-ui-change-screenshots",
      "Do not capture before/change/after screenshots for UI change timelines.",
    )
    .option(
      "--no-ui-change-snapshots",
      "Do not capture before/after accessibility snapshots for UI change timelines.",
    )
    .option(
      "--no-ui-change-dom-snapshots",
      "Do not capture before/after visible DOM summaries for UI change timelines.",
    )
    .option(
      "--no-curate-bookmarks",
      "Disable post-run Pi bookmark chapter curation.",
    )
    .option(
      "--bookmark-curator <name>",
      "Bookmark curator factory to use.",
      "pi",
    )
    .option(
      "--bookmark-system-prompt <path>",
      "Path to a custom system prompt for bookmark curation.",
    )
    .option(
      "--data-lifecycle <path>",
      "JourneyTest data lifecycle config JSON file.",
    )
    .option(
      "--data-lifecycle-provider <name>",
      "Data lifecycle provider factory to use.",
      "default",
    )
    .option("--keep-data", "Skip configured data lifecycle cleanup operations.")
    .option("--junit <path>", "Write a JUnit XML report for CI systems.")
    .option(
      "--github-annotations",
      "Emit GitHub Actions workflow-command annotations.",
    )
    .option("--summary-json <path>", "Write a compact CI summary JSON report.")
    .option(
      "--compare-to <path>",
      "Previous run.json or suite run directory to compare against.",
    )
    .option(
      "--tag <tag>",
      "Only run journeys with this tag. Repeat for OR matching.",
      collectRepeatableOption,
      [],
    )
    .option(
      "--exclude-tag <tag>",
      "Skip journeys with this tag. Repeatable.",
      collectRepeatableOption,
      [],
    )
    .option(
      "--journey-id <id>",
      "Only run this journey id. Repeatable.",
      collectRepeatableOption,
      [],
    )
    .option(
      "--exclude-journey-id <id>",
      "Skip this journey id. Repeatable.",
      collectRepeatableOption,
      [],
    )
    .option(
      "--rerun-failed <path>",
      "Prior run.json, history.json, or suite run directory; rerun journeys that were not healthy.",
    )
    .option(
      "--shard <index>/<total>",
      "Run one deterministic shard after filtering, using 1-based shard index.",
    )
    .action(
      async (
        journeyPath: string,
        options: {
          profile?: string;
          profiles?: string;
          out: string;
          director: string;
          browser: string;
          provider: string;
          model: string;
          auth?: string;
          session?: string;
          state?: string;
          headed?: boolean;
          viewport?: string;
          device?: string;
          retries: string;
          journeyTimeoutMs: string;
          parallelAgents: string;
          parallelBrowserMode: string;
          video?: boolean;
          uiChangeRecording?: boolean;
          uiChangeTimeoutMs?: string;
          uiChangeQuietMs?: string;
          uiChangeMaxChanges?: string;
          uiChangeMaxScreenshots?: string;
          uiChangeScreenshots?: boolean;
          uiChangeSnapshots?: boolean;
          uiChangeDomSnapshots?: boolean;
          curateBookmarks?: boolean;
          bookmarkCurator: string;
          bookmarkSystemPrompt?: string;
          dataLifecycle?: string;
          dataLifecycleProvider: string;
          keepData?: boolean;
          junit?: string;
          githubAnnotations?: boolean;
          summaryJson?: string;
          compareTo?: string;
          tag: string[];
          excludeTag: string[];
          journeyId: string[];
          excludeJourneyId: string[];
          rerunFailed?: string;
          shard?: string;
        },
      ) => {
        const profilePath = options.profiles ?? options.profile;
        if (!profilePath) {
          throw new Error(
            "Pass --profile <path> or --profiles <path> so journeys can resolve tester profiles.",
          );
        }

        const bookmarkCuratorName = bookmarkCuratorNameForOptions(options);
        factories.directors.assertRegistered(options.director);
        factories.browserDrivers.assertRegistered(options.browser);
        factories.bookmarkCurators.assertRegistered(bookmarkCuratorName);
        if (options.dataLifecycle) {
          factories.dataLifecycleProviders.assertRegistered(
            options.dataLifecycleProvider,
          );
        }

        const journeyRoot = resolve(journeyPath);
        const collectedItems = await collectRunnableJourneys(
          journeyRoot,
          resolve(profilePath),
        );
        if (collectedItems.length === 0) {
          throw new Error(`No journey JSON files found under ${journeyRoot}.`);
        }
        const rerunFailed = options.rerunFailed
          ? await loadRerunFailedSelection(resolve(options.rerunFailed))
          : undefined;
        const selection = buildJourneySelection({
          tags: options.tag,
          excludeTags: options.excludeTag,
          journeyIds: options.journeyId,
          excludeJourneyIds: options.excludeJourneyId,
          ...(rerunFailed ? { rerunFailed } : {}),
          shard: options.shard,
        });
        const selectionResult = selectRunnableJourneys(
          collectedItems,
          selection,
        );
        const items = selectionResult.items;
        if (items.length === 0) {
          throw new Error(
            `No journeys selected after applying run filters. Collected ${collectedItems.length} journey(s).`,
          );
        }

        const parallelAgents = parseParallelAgents(options.parallelAgents);
        const retries = parseRetries(options.retries);
        const journeyTimeoutMs = parseJourneyTimeoutMs(
          options.journeyTimeoutMs,
        );
        const parallelBrowserMode = parseParallelBrowserMode(
          options.parallelBrowserMode,
        );
        const browserEnvironmentOverrides =
          buildBrowserEnvironmentOptions(options);
        const uiChangeRecordingOptions = buildUiChangeRecordingOptions(options);
        const authPath = await resolveAuthPath(options.auth);
        const authLoader = createOAuthAuthLoader(authPath.path);
        const bookmarkSystemPrompt = options.bookmarkSystemPrompt
          ? await readFile(resolve(options.bookmarkSystemPrompt), "utf8")
          : undefined;
        const directorFactoryContext = {
          provider: options.provider,
          modelId: options.model,
          getApiKey: authLoader,
        };
        const bookmarkCuratorFactoryContext = {
          provider: options.provider,
          modelId: options.model,
          getApiKey: authLoader,
          systemPrompt: bookmarkSystemPrompt,
        };
        await assertFactoryOAuthCredentialsAvailable(
          [
            factories.directors.authProvider(
              options.director,
              directorFactoryContext,
            ),
            factories.bookmarkCurators.authProvider(
              bookmarkCuratorName,
              bookmarkCuratorFactoryContext,
            ),
          ],
          authPath,
        );
        const dataLifecycleConfig = options.dataLifecycle
          ? await readAndParseJsonFile(
              resolve(options.dataLifecycle),
              DataLifecycleConfigSchema,
            )
          : undefined;
        const dataLifecycleProvider = dataLifecycleConfig
          ? factories.dataLifecycleProviders.create(
              options.dataLifecycleProvider,
              {},
            )
          : undefined;
        const baseOutputDir = resolve(options.out);
        const comparisonBaseline = options.compareTo
          ? await loadComparisonBaseline(resolve(options.compareTo))
          : undefined;
        const isDirectoryRun = (await stat(journeyRoot)).isDirectory();
        const runOutputDir = isDirectoryRun
          ? join(baseOutputDir, `${isoTimestampForPath()}-run`)
          : baseOutputDir;
        if (isDirectoryRun || dataLifecycleConfig?.suiteLifecycle) {
          await mkdir(runOutputDir, { recursive: true });
        }
        const suiteRunId = isDirectoryRun
          ? basename(runOutputDir)
          : `${isoTimestampForPath()}-suite`;
        console.log(`Collected ${collectedItems.length} journey(s).`);
        if (selectionResult.summary) {
          console.log(`Selected ${items.length} journey(s) after filters.`);
        }
        console.log(
          `Parallel agents: ${Math.min(parallelAgents, items.length)}`,
        );
        if (retries > 0) {
          console.log(`Retries: ${retries}`);
        }
        const sharedBrowserTabs = shouldUseSharedBrowserTabs({
          browser: options.browser,
          parallelAgents,
          journeyCount: items.length,
          parallelBrowserMode,
        });
        if (
          parallelBrowserMode === "shared-tabs" &&
          options.browser !== "agent-browser" &&
          parallelAgents > 1 &&
          items.length > 1
        ) {
          throw new Error(
            '--parallel-browser-mode shared-tabs is only supported by the "agent-browser" browser driver.',
          );
        }
        const sharedBrowserSessionName = sharedBrowserTabs
          ? parallelBrowserSessionName(options.session, suiteRunId)
          : undefined;
        if (parallelAgents > 1 && items.length > 1) {
          console.log(
            `Browser parallel mode: ${
              sharedBrowserTabs ? "shared-tabs" : "isolated-sessions"
            }`,
          );
          if (sharedBrowserTabs) {
            console.log(`Shared browser session: ${sharedBrowserSessionName}`);
            if (options.video ?? true) {
              console.log(
                "Shared-tab video recording is serialized per journey because agent-browser supports one active recording per session.",
              );
            }
          }
        }
        if (isDirectoryRun) {
          console.log(`Run output: ${runOutputDir}`);
        }
        if (comparisonBaseline) {
          console.log(
            `Comparison baseline: ${comparisonBaseline.sourcePath} (${comparisonBaseline.runs.length} run(s))`,
          );
        }
        if (dataLifecycleConfig) {
          console.log(
            `Data lifecycle config: ${resolve(options.dataLifecycle as string)}`,
          );
          if (options.keepData) {
            console.log("Data lifecycle cleanup: skipped by --keep-data");
          }
        }
        if (browserEnvironmentOverrides) {
          console.log(
            `Browser environment overrides: ${formatBrowserEnvironment(browserEnvironmentOverrides)}`,
          );
        }
        if (!sharedBrowserTabs && parallelAgents > 1 && options.session) {
          console.log(`Browser session prefix: ${options.session}`);
        }

        let appLifecycleController: AppLifecycleController | undefined;
        let removeAppLifecycleSignalHandlers: (() => void) | undefined;
        let runtimeItems = items;
        let suiteLifecycleController: DataLifecycleController | undefined;
        let suiteLifecycleBlocked = false;
        let suiteRuns: Array<{
          journeyFile: string;
          result: Awaited<ReturnType<typeof runJourney>>;
        }> = [];

        try {
          if (dataLifecycleConfig?.appLifecycle) {
            appLifecycleController = await AppLifecycleController.create({
              config: dataLifecycleConfig.appLifecycle,
              suiteRunId,
              runDir: join(runOutputDir, "_app-lifecycle"),
            });
            removeAppLifecycleSignalHandlers =
              installAppLifecycleSignalCleanup(appLifecycleController);

            console.log("");
            console.log("Running app lifecycle start");
            await appLifecycleController.runStart();
            console.log(
              `App lifecycle: ${appLifecycleController.result.status}`,
            );
            console.log(
              `App lifecycle artifacts: ${join(runOutputDir, "_app-lifecycle")}`,
            );

            if (appLifecycleController.appTarget) {
              runtimeItems = items.map((item) => ({
                ...item,
                journey: applyAppTargetOverride(
                  item.journey,
                  appLifecycleController?.appTarget,
                ),
              }));
              console.log(
                `App target: ${appLifecycleController.appTarget.baseUrl}`,
              );
            }
          }

          if (dataLifecycleConfig?.suiteLifecycle && dataLifecycleProvider) {
            suiteLifecycleController = new DataLifecycleController({
              definition: dataLifecycleConfig.suiteLifecycle,
              environments: dataLifecycleConfig.dataEnvironments,
              provider: dataLifecycleProvider,
              scope: "suite",
              runId: suiteRunId,
              runDir: join(runOutputDir, "_suite-lifecycle"),
              suiteRunId,
              keepData: options.keepData,
            });

            console.log("");
            console.log("Running suite data lifecycle setup/preflight");
            try {
              await suiteLifecycleController.runSetupAndPreflight();
              console.log(
                `Suite data lifecycle: ${suiteLifecycleController.result.status}`,
              );
            } catch (error) {
              suiteLifecycleBlocked = true;
              process.exitCode = 1;
              const message =
                error instanceof Error ? error.message : String(error);
              console.error(`Suite data lifecycle blocked the run: ${message}`);
            }
          }

          if (!suiteLifecycleBlocked) {
            suiteRuns = await mapConcurrent(
              runtimeItems,
              parallelAgents,
              async (item, index) => {
                console.log("");
                console.log(
                  `Running ${item.journey.id} (${index + 1}/${runtimeItems.length})`,
                );
                console.log(`Source: ${item.journeyFile}`);

                const result = await runJourneyWithRetries({
                  item,
                  retries,
                  outputDir: runOutputDir,
                  createDriver: () =>
                    factories.browserDrivers.create(options.browser, {}),
                  createDirector: () =>
                    factories.directors.create(
                      options.director,
                      directorFactoryContext,
                    ),
                  createBookmarkCurator: () =>
                    factories.bookmarkCurators.create(
                      bookmarkCuratorName,
                      bookmarkCuratorFactoryContext,
                  ),
                  video: options.video,
                  directorTimeoutMs: journeyTimeoutMs,
                  uiChangeRecording: options.uiChangeRecording,
                  uiChangeRecordingOptions,
                  sessionName: browserSessionNameForRun({
                    baseSession: options.session,
                    parallelAgents,
                    journeyId: item.journey.id,
                    index,
                    suiteRunId,
                    sharedBrowserTabs,
                  }),
                  tabLabel: browserTabLabelForRun({
                    parallelAgents,
                    journeyId: item.journey.id,
                    index,
                    sharedBrowserTabs,
                  }),
                  statePath: options.state ? resolve(options.state) : undefined,
                  headed: options.headed,
                  browserEnvironment: mergeBrowserEnvironmentOptions(
                    item.journey.browserEnvironment,
                    browserEnvironmentOverrides,
                  ),
                  ...(dataLifecycleConfig && dataLifecycleProvider
                    ? {
                        dataLifecycle: {
                          environments: dataLifecycleConfig.dataEnvironments,
                          provider: dataLifecycleProvider,
                          keepData: options.keepData,
                          suiteRunId,
                          suiteManifest: suiteLifecycleController?.manifest,
                        },
                      }
                    : {}),
                });

                printRunResult(result);

                if (!runPassed(result)) {
                  process.exitCode = 1;
                }

                return { journeyFile: item.journeyFile, result };
              },
            );
          }
        } finally {
          if (suiteLifecycleController) {
            if (!suiteLifecycleBlocked) {
              await suiteLifecycleController.runPostconditions();
            }
            await suiteLifecycleController.runCleanup();
            suiteLifecycleController.finish();
            console.log("");
            console.log(
              `Suite data lifecycle: ${suiteLifecycleController.result.status}`,
            );
            console.log(
              `Suite lifecycle artifacts: ${join(runOutputDir, "_suite-lifecycle")}`,
            );
            if (
              suiteLifecycleController.result.status === "failed" ||
              suiteLifecycleController.result.status === "blocked"
            ) {
              process.exitCode = 1;
            }
          }
          if (appLifecycleController) {
            await appLifecycleController.runCleanup();
            console.log("");
            console.log(
              `App lifecycle: ${appLifecycleController.result.status}`,
            );
            console.log(
              `App lifecycle artifacts: ${join(runOutputDir, "_app-lifecycle")}`,
            );
            if (appLifecycleController.result.status === "failed") {
              process.exitCode = 1;
            }
          }
          if (removeAppLifecycleSignalHandlers) {
            removeAppLifecycleSignalHandlers();
          }
        }

        if (suiteLifecycleBlocked) {
          await writeCliCiOutputs({
            suiteRunId,
            suiteRuns,
            junitPath: options.junit,
            summaryJsonPath: options.summaryJson,
            githubAnnotations: options.githubAnnotations,
          });
          return;
        }

        if (isDirectoryRun) {
          const suiteArtifacts = await writeSuiteArtifacts(
            runOutputDir,
            suiteRuns,
            comparisonBaseline,
            selectionResult.summary,
          );
          console.log("");
          console.log(`Run dashboard: ${suiteArtifacts.dashboard}`);
          console.log(
            `Run dashboard URL: ${pathToFileURL(suiteArtifacts.dashboard).href}`,
          );
          console.log(`Run history: ${suiteArtifacts.history}`);
          console.log("");
          console.log("Journey dashboards:");
          for (const run of suiteRuns) {
            console.log(
              `- ${run.result.journeyId}: ${run.result.artifacts.dashboard}`,
            );
          }
        }

        await writeCliCiOutputs({
          suiteRunId,
          suiteRuns,
          junitPath: options.junit,
          summaryJsonPath: options.summaryJson,
          githubAnnotations: options.githubAnnotations,
        });
      },
    );

  await program.parseAsync(argv);
}

type StoredOAuthAuth = Record<string, OAuthCredentials & { type?: string }>;
export type AuthPathSource = "cli" | "env" | "local" | "user-config";

export interface AuthPathResolution {
  path: string;
  source: AuthPathSource;
  localPath: string;
  userConfigPath: string;
}

export interface AuthPathResolutionOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  platform?: NodeJS.Platform;
  fileExists?: (path: string) => Promise<boolean>;
}

export interface OAuthAuthStatus {
  path: string;
  source: AuthPathSource;
  exists: boolean;
  configuredProviders: string[];
  availableOAuthProviders: string[];
}

export interface RunnableJourney {
  journeyFile: string;
  journey: UserJourney;
  profile: TesterProfile;
}

interface ComparisonBaseline {
  sourcePath: string;
  kind: "run" | "suite";
  runs: RunResult[];
}

export interface RerunFailedSelection {
  sourcePath: string;
  unhealthyJourneyIds: string[];
}

export interface JourneySelection {
  tags: string[];
  excludeTags: string[];
  journeyIds: string[];
  excludeJourneyIds: string[];
  rerunFailed?: RerunFailedSelection;
  shard?: ShardSelection;
}

export interface ShardSelection {
  index: number;
  total: number;
}

export interface JourneySelectionResult {
  items: RunnableJourney[];
  summary?: SuiteSelectionSummary;
}

export function parseParallelAgents(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `--parallel-agents must be a positive integer. Received "${value}".`,
    );
  }
  return parsed;
}

export function parseParallelBrowserMode(value: string): ParallelBrowserMode {
  if (value === "shared-tabs" || value === "isolated-sessions") {
    return value;
  }
  throw new Error(
    `--parallel-browser-mode must be "shared-tabs" or "isolated-sessions". Received "${value}".`,
  );
}

export function parseRetries(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--retries must be a non-negative integer. Received "${value}".`);
  }
  return parsed;
}

export function parseViewportOption(
  value: string,
): BrowserEnvironment["viewport"] {
  const match = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(value.trim());
  if (!match) {
    throw new Error(
      `--viewport must use <width>x<height>, optionally <width>x<height>@<scale>. Received "${value}".`,
    );
  }

  const width = Number(match[1]);
  const height = Number(match[2]);
  const deviceScaleFactor = match[3] ? Number(match[3]) : undefined;
  if (
    !Number.isInteger(width) ||
    width < 1 ||
    !Number.isInteger(height) ||
    height < 1 ||
    (deviceScaleFactor !== undefined &&
      (!Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0))
  ) {
    throw new Error(
      `--viewport must use positive dimensions and scale. Received "${value}".`,
    );
  }

  return {
    width,
    height,
    ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
  };
}

export function parseBrowserDevicePreset(value: string): BrowserDevicePreset {
  if (value === "iphone-14" || value === "pixel-7" || value === "ipad-pro-11") {
    return value;
  }
  throw new Error(
    `--device must be one of: iphone-14, pixel-7, ipad-pro-11. Received "${value}".`,
  );
}

export function buildBrowserEnvironmentOptions(options: {
  viewport?: string;
  device?: string;
}): BrowserEnvironment | undefined {
  const environment: BrowserEnvironment = {
    ...(options.device ? { device: parseBrowserDevicePreset(options.device) } : {}),
    ...(options.viewport ? { viewport: parseViewportOption(options.viewport) } : {}),
  };

  return Object.keys(environment).length > 0 ? environment : undefined;
}

export function mergeBrowserEnvironmentOptions(
  defaults: BrowserEnvironment | undefined,
  overrides: BrowserEnvironment | undefined,
): BrowserEnvironment | undefined {
  const viewport = mergeViewportOptions(defaults?.viewport, overrides?.viewport);
  const environment: BrowserEnvironment = {
    ...(defaults ?? {}),
    ...(overrides ?? {}),
    ...(viewport ? { viewport } : {}),
  };

  return Object.keys(environment).length > 0 ? environment : undefined;
}

function mergeViewportOptions(
  defaults: BrowserEnvironment["viewport"] | undefined,
  overrides: BrowserEnvironment["viewport"] | undefined,
): BrowserEnvironment["viewport"] | undefined {
  if (!defaults && !overrides) {
    return undefined;
  }

  const width = overrides?.width ?? defaults?.width;
  const height = overrides?.height ?? defaults?.height;
  if (width === undefined || height === undefined) {
    return undefined;
  }

  const deviceScaleFactor = overrides?.deviceScaleFactor ?? defaults?.deviceScaleFactor;
  return {
    width,
    height,
    ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
  };
}

function formatBrowserEnvironment(environment: BrowserEnvironment): string {
  const parts = [
    environment.device ? `device=${environment.device}` : undefined,
    environment.viewport
      ? `viewport=${environment.viewport.width}x${environment.viewport.height}${
          environment.viewport.deviceScaleFactor === undefined
            ? ""
            : `@${environment.viewport.deviceScaleFactor}`
        }`
      : undefined,
  ].filter(Boolean);
  return parts.join(", ");
}

export function buildJourneySelection(options: {
  tags?: string[];
  excludeTags?: string[];
  journeyIds?: string[];
  excludeJourneyIds?: string[];
  rerunFailed?: RerunFailedSelection;
  shard?: string;
}): JourneySelection {
  const tags = uniqueSelectorValues("--tag", options.tags ?? []);
  const excludeTags = uniqueSelectorValues(
    "--exclude-tag",
    options.excludeTags ?? [],
  );
  const journeyIds = uniqueSelectorValues(
    "--journey-id",
    options.journeyIds ?? [],
  );
  const excludeJourneyIds = uniqueSelectorValues(
    "--exclude-journey-id",
    options.excludeJourneyIds ?? [],
  );
  assertDisjointSelectors("--tag", tags, "--exclude-tag", excludeTags);
  assertDisjointSelectors(
    "--journey-id",
    journeyIds,
    "--exclude-journey-id",
    excludeJourneyIds,
  );

  return {
    tags,
    excludeTags,
    journeyIds,
    excludeJourneyIds,
    ...(options.rerunFailed ? { rerunFailed: options.rerunFailed } : {}),
    ...(options.shard ? { shard: parseShardSelection(options.shard) } : {}),
  };
}

export function parseShardSelection(value: string): ShardSelection {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match) {
    throw new Error(
      `--shard must use the format <index>/<total> with positive integers. Received "${value}".`,
    );
  }
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (index > total) {
    throw new Error(
      `--shard index must be less than or equal to total. Received "${value}".`,
    );
  }
  return { index, total };
}

export function selectRunnableJourneys(
  items: RunnableJourney[],
  selection: JourneySelection,
): JourneySelectionResult {
  validateKnownJourneyIds(items, selection.journeyIds, "--journey-id");
  validateKnownJourneyIds(
    items,
    selection.excludeJourneyIds,
    "--exclude-journey-id",
  );

  const rerunIds = selection.rerunFailed
    ? new Set(selection.rerunFailed.unhealthyJourneyIds)
    : undefined;
  let selected = items.filter((item) => {
    const journeyTags = new Set(item.journey.tags ?? []);
    if (
      selection.journeyIds.length > 0 &&
      !selection.journeyIds.includes(item.journey.id)
    ) {
      return false;
    }
    if (selection.excludeJourneyIds.includes(item.journey.id)) {
      return false;
    }
    if (
      selection.tags.length > 0 &&
      !selection.tags.some((tag) => journeyTags.has(tag))
    ) {
      return false;
    }
    if (selection.excludeTags.some((tag) => journeyTags.has(tag))) {
      return false;
    }
    if (rerunIds && !rerunIds.has(item.journey.id)) {
      return false;
    }
    return true;
  });

  if (selection.shard) {
    selected = selected.filter(
      (_item, index) =>
        index % selection.shard!.total === selection.shard!.index - 1,
    );
  }

  const summary = buildSelectionSummary(
    items.length,
    selected.length,
    selection,
  );
  return { items: selected, ...(summary ? { summary } : {}) };
}

function buildSelectionSummary(
  collected: number,
  selected: number,
  selection: JourneySelection,
): SuiteSelectionSummary | undefined {
  const hasSelection =
    selection.tags.length > 0 ||
    selection.excludeTags.length > 0 ||
    selection.journeyIds.length > 0 ||
    selection.excludeJourneyIds.length > 0 ||
    Boolean(selection.rerunFailed) ||
    Boolean(selection.shard);
  if (!hasSelection) {
    return undefined;
  }

  return {
    collected,
    selected,
    ...(selection.tags.length > 0 ? { tags: selection.tags } : {}),
    ...(selection.excludeTags.length > 0
      ? { excludeTags: selection.excludeTags }
      : {}),
    ...(selection.journeyIds.length > 0
      ? { journeyIds: selection.journeyIds }
      : {}),
    ...(selection.excludeJourneyIds.length > 0
      ? { excludeJourneyIds: selection.excludeJourneyIds }
      : {}),
    ...(selection.rerunFailed
      ? {
          rerunFailed: {
            path: selection.rerunFailed.sourcePath,
            unhealthyJourneyIds: selection.rerunFailed.unhealthyJourneyIds,
          },
        }
      : {}),
    ...(selection.shard ? { shard: selection.shard } : {}),
  };
}

function uniqueSelectorValues(optionName: string, values: string[]): string[] {
  const trimmed = values.map((value) => value.trim());
  if (trimmed.some((value) => value.length === 0)) {
    throw new Error(`${optionName} values must be non-empty.`);
  }
  return [...new Set(trimmed)];
}

function assertDisjointSelectors(
  includeName: string,
  includeValues: string[],
  excludeName: string,
  excludeValues: string[],
): void {
  const excludeSet = new Set(excludeValues);
  const overlaps = includeValues.filter((value) => excludeSet.has(value));
  if (overlaps.length > 0) {
    throw new Error(
      `${includeName} and ${excludeName} cannot contain the same value(s): ${overlaps.join(", ")}.`,
    );
  }
}

function validateKnownJourneyIds(
  items: RunnableJourney[],
  ids: string[],
  optionName: string,
): void {
  if (ids.length === 0) {
    return;
  }
  const knownIds = new Set(items.map((item) => item.journey.id));
  const unknown = ids.filter((id) => !knownIds.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `${optionName} referenced journey id(s) that were not collected: ${unknown.join(", ")}.`,
    );
  }
}

export function parseDataOptions(values: string[]): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  for (const value of values) {
    const equalsIndex = value.indexOf("=");
    if (equalsIndex <= 0) {
      throw new Error(
        `--data values must use key=value syntax. Received "${value}".`,
      );
    }

    const key = value.slice(0, equalsIndex).trim();
    if (!key) {
      throw new Error(
        `--data values must include a non-empty key. Received "${value}".`,
      );
    }

    const rawValue = value.slice(equalsIndex + 1);
    data[key] = parseJsonLikeValue(rawValue);
  }

  return data;
}

function parseJsonLikeValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export function buildUiChangeRecordingOptions(options: {
  uiChangeTimeoutMs?: string;
  uiChangeQuietMs?: string;
  uiChangeMaxChanges?: string;
  uiChangeMaxScreenshots?: string;
  uiChangeScreenshots?: boolean;
  uiChangeSnapshots?: boolean;
  uiChangeDomSnapshots?: boolean;
}): UiChangeRecordingOptions | undefined {
  const recordingOptions: UiChangeRecordingOptions = {
    ...(options.uiChangeTimeoutMs
      ? {
          timeoutMs: parsePositiveIntegerOption(
            "--ui-change-timeout-ms",
            options.uiChangeTimeoutMs,
          ),
        }
      : {}),
    ...(options.uiChangeQuietMs
      ? {
          quietMs: parsePositiveIntegerOption(
            "--ui-change-quiet-ms",
            options.uiChangeQuietMs,
          ),
        }
      : {}),
    ...(options.uiChangeMaxChanges
      ? {
          maxChanges: parsePositiveIntegerOption(
            "--ui-change-max-changes",
            options.uiChangeMaxChanges,
          ),
        }
      : {}),
    ...(options.uiChangeMaxScreenshots
      ? {
          maxScreenshots: parseNonNegativeIntegerOption(
            "--ui-change-max-screenshots",
            options.uiChangeMaxScreenshots,
          ),
        }
      : {}),
    ...(options.uiChangeScreenshots === undefined
      ? {}
      : { screenshots: options.uiChangeScreenshots }),
    ...(options.uiChangeSnapshots === undefined
      ? {}
      : { snapshots: options.uiChangeSnapshots }),
    ...(options.uiChangeDomSnapshots === undefined
      ? {}
      : { domSnapshots: options.uiChangeDomSnapshots }),
  };

  return Object.keys(recordingOptions).length > 0
    ? recordingOptions
    : undefined;
}

export function parseJourneyTimeoutMs(value: string): number | undefined {
  if (value === "0") {
    return undefined;
  }
  return parsePositiveIntegerOption("--journey-timeout-ms", value);
}

function parsePositiveIntegerOption(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer. Received "${value}".`);
  }
  return parsed;
}

function parseNonNegativeIntegerOption(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `${name} must be a non-negative integer. Received "${value}".`,
    );
  }
  return parsed;
}

export function sessionNameForRun(
  baseSession: string | undefined,
  parallelAgents: number,
  journeyId: string,
  index: number,
): string | undefined {
  if (!baseSession) {
    return undefined;
  }

  if (parallelAgents <= 1) {
    return baseSession;
  }

  return `${baseSession}-${String(index + 1).padStart(2, "0")}-${sanitizePathSegment(journeyId)}`;
}

export function shouldUseSharedBrowserTabs(options: {
  browser: string;
  parallelAgents: number;
  journeyCount: number;
  parallelBrowserMode: ParallelBrowserMode;
}): boolean {
  return (
    options.browser === "agent-browser" &&
    options.parallelAgents > 1 &&
    options.journeyCount > 1 &&
    options.parallelBrowserMode === "shared-tabs"
  );
}

export function parallelBrowserSessionName(
  baseSession: string | undefined,
  suiteRunId: string,
): string {
  return baseSession ?? suiteRunId;
}

export function browserSessionNameForRun(options: {
  baseSession: string | undefined;
  parallelAgents: number;
  journeyId: string;
  index: number;
  suiteRunId: string;
  sharedBrowserTabs: boolean;
}): string | undefined {
  if (options.sharedBrowserTabs) {
    return parallelBrowserSessionName(options.baseSession, options.suiteRunId);
  }

  return sessionNameForRun(
    options.baseSession,
    options.parallelAgents,
    options.journeyId,
    options.index,
  );
}

export function browserTabLabelForRun(options: {
  parallelAgents: number;
  journeyId: string;
  index: number;
  sharedBrowserTabs: boolean;
}): string | undefined {
  if (!options.sharedBrowserTabs) {
    return undefined;
  }

  return `journey-${String(options.index + 1).padStart(2, "0")}-${sanitizePathSegment(options.journeyId)}`;
}

export function bookmarkCuratorNameForOptions(options: {
  bookmarkCurator?: string;
  curateBookmarks?: boolean;
}): string {
  if (options.curateBookmarks === false) {
    return "none";
  }

  return options.bookmarkCurator ?? "pi";
}

interface RunJourneyWithRetriesOptions {
  item: RunnableJourney;
  retries: number;
  outputDir: string;
  createDriver: () => BrowserDriver;
  createDirector: () => AgentDirector;
  createBookmarkCurator: () => BookmarkCurator | undefined;
  video?: boolean;
  directorTimeoutMs?: number;
  uiChangeRecording?: boolean;
  uiChangeRecordingOptions?: UiChangeRecordingOptions;
  sessionName?: string;
  tabLabel?: string;
  statePath?: string;
  headed?: boolean;
  browserEnvironment?: BrowserEnvironment;
  dataLifecycle?: RunJourneyOptions["dataLifecycle"];
}

async function runJourneyWithRetries(
  options: RunJourneyWithRetriesOptions,
): Promise<RunResult> {
  const maxAttempts = options.retries + 1;
  const attempts: RunAttempt[] = [];
  let finalResult: RunResult | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      console.log(
        `Retrying ${options.item.journey.id} (${attempt}/${maxAttempts})`,
      );
    }

    const result = await runJourney({
      journey: options.item.journey,
      profile: options.item.profile,
      driver: options.createDriver(),
      director: options.createDirector(),
      outputDir: options.outputDir,
      video: options.video,
      directorTimeoutMs: options.directorTimeoutMs,
      uiChangeRecording: options.uiChangeRecording,
      uiChangeRecordingOptions: options.uiChangeRecordingOptions,
      sessionName: attemptScopedValue(options.sessionName, attempt),
      tabLabel: attemptScopedValue(options.tabLabel, attempt),
      statePath: options.statePath,
      headed: options.headed,
      browserEnvironment: options.browserEnvironment,
      bookmarkCurator: options.createBookmarkCurator(),
      dataLifecycle: options.dataLifecycle,
    });

    attempts.push(createRunAttempt(attempt, result));
    finalResult = result;
    if (runPassed(result)) {
      break;
    }
  }

  if (!finalResult) {
    throw new Error(`No attempts were run for ${options.item.journey.id}.`);
  }

  const annotated = annotateFinalRunResult({
    result: finalResult,
    attempts,
    retries: options.retries,
    quarantined: options.item.journey.quarantined ?? false,
  });
  await persistRunResult(annotated);
  return annotated;
}

function annotateFinalRunResult(options: {
  result: RunResult;
  attempts: RunAttempt[];
  retries: number;
  quarantined: boolean;
}): RunResult {
  const passedAttempt = options.attempts.find((attempt) => attempt.passed);
  const failedAttemptsBeforePass = passedAttempt
    ? options.attempts.filter(
        (attempt) => attempt.attempt < passedAttempt.attempt && !attempt.passed,
      ).length
    : 0;

  return {
    ...options.result,
    attempts: options.attempts,
    flake: {
      isFlaky: Boolean(passedAttempt && failedAttemptsBeforePass > 0),
      retries: options.retries,
      attempts: options.attempts.length,
      ...(passedAttempt ? { passedAttempt: passedAttempt.attempt } : {}),
      failedAttemptsBeforePass,
    },
    ...(options.quarantined
      ? { quarantine: { quarantined: true } }
      : options.result.quarantine
        ? { quarantine: options.result.quarantine }
        : {}),
  };
}

function createRunAttempt(attempt: number, result: RunResult): RunAttempt {
  return {
    attempt,
    runId: result.runId,
    runStatus: result.runStatus,
    ...(result.verdict?.status ? { verdictStatus: result.verdict.status } : {}),
    ...(result.dataLifecycle?.status
      ? { dataLifecycleStatus: result.dataLifecycle.status }
      : {}),
    passed: runPassed(result),
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    durationMs: result.durationMs,
    dashboard: result.artifacts.dashboard,
    result: result.artifacts.result,
    ...(result.verdict?.summary || result.error?.message
      ? { summary: result.verdict?.summary ?? result.error?.message }
      : {}),
  };
}

function runPassed(result: RunResult): boolean {
  return (
    result.runStatus === "completed" &&
    result.verdict?.status === "passed" &&
    result.dataLifecycle?.status !== "failed" &&
    result.dataLifecycle?.status !== "blocked"
  );
}

function attemptScopedValue(
  value: string | undefined,
  attempt: number,
): string | undefined {
  if (!value || attempt === 1) {
    return value;
  }
  return `${value}-attempt-${attempt}`;
}

async function persistRunResult(result: RunResult): Promise<void> {
  await writeFile(
    result.artifacts.result,
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
}

async function mapConcurrent<T, TResult>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await mapper(items[index] as T, index);
      }
    }),
  );

  return results;
}

function createOAuthAuthLoader(
  authPath: string,
): (provider: string) => Promise<string | undefined> {
  let cachedAuth: StoredOAuthAuth | undefined;
  let queue: Promise<void> = Promise.resolve();

  return async (provider: string) => {
    const operation = queue.then(async () => {
      const auth = cachedAuth ?? (cachedAuth = await readOAuthAuth(authPath));
      const result = await getOAuthApiKey(provider, auth);
      if (!result) {
        return undefined;
      }

      if (auth[provider] !== result.newCredentials) {
        auth[provider] = { type: "oauth", ...result.newCredentials };
        cachedAuth = auth;
        await mkdir(dirname(authPath), { recursive: true });
        await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
      }

      return result.apiKey;
    });

    queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };
}

export async function getOAuthAuthStatus(
  authPath: AuthPathResolution,
): Promise<OAuthAuthStatus> {
  const exists = await pathExists(authPath.path);
  const auth = await readOAuthAuth(authPath.path);
  return {
    path: authPath.path,
    source: authPath.source,
    exists,
    configuredProviders: Object.keys(auth).sort(),
    availableOAuthProviders: getOAuthProviders()
      .map((provider) => provider.id)
      .sort(),
  };
}

async function assertFactoryOAuthCredentialsAvailable(
  providers: Array<string | undefined>,
  authPath: AuthPathResolution,
): Promise<void> {
  const authProviders = new Set(
    providers.filter((provider): provider is string => Boolean(provider)),
  );
  await Promise.all(
    [...authProviders].map((provider) =>
      assertOAuthCredentialsAvailable(provider, authPath),
    ),
  );
}

async function assertOAuthCredentialsAvailable(
  provider: string,
  authPath: AuthPathResolution,
): Promise<void> {
  if (!getOAuthProvider(provider)) {
    return;
  }

  const auth = await readOAuthAuth(authPath.path);
  if (auth[provider]) {
    return;
  }

  throw new Error(formatMissingOAuthCredentialsMessage(provider, authPath));
}

async function readOAuthAuth(authPath: string): Promise<StoredOAuthAuth> {
  try {
    return JSON.parse(await readFile(authPath, "utf8")) as StoredOAuthAuth;
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? error.code
        : undefined;
    if (code === "ENOENT") {
      return {};
    }
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof SyntaxError) {
      throw new Error(
        `Could not parse OAuth auth file at ${authPath}: ${message}`,
      );
    }
    throw new Error(
      `Could not read OAuth auth file at ${authPath}: ${message}`,
    );
  }
}

export async function resolveAuthPath(
  authPathOption?: string,
  options: AuthPathResolutionOptions = {},
): Promise<AuthPathResolution> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const localPath = resolve(cwd, "auth.json");
  const userConfigPath = defaultUserAuthPath({
    env,
    homeDir: options.homeDir,
    platform: options.platform,
  });

  if (authPathOption) {
    return {
      path: resolve(cwd, authPathOption),
      source: "cli",
      localPath,
      userConfigPath,
    };
  }

  if (env.JOURNEYTEST_AUTH_PATH) {
    return {
      path: resolve(cwd, env.JOURNEYTEST_AUTH_PATH),
      source: "env",
      localPath,
      userConfigPath,
    };
  }

  const fileExists = options.fileExists ?? pathExists;
  if (await fileExists(localPath)) {
    return {
      path: localPath,
      source: "local",
      localPath,
      userConfigPath,
    };
  }

  return {
    path: userConfigPath,
    source: "user-config",
    localPath,
    userConfigPath,
  };
}

export function defaultUserAuthPath(
  options: {
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    platform?: NodeJS.Platform;
  } = {},
): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const platform = options.platform ?? process.platform;

  if (platform === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "JourneyTest",
      "auth.json",
    );
  }
  if (platform === "win32") {
    return join(
      env.APPDATA ?? join(home, "AppData", "Roaming"),
      "JourneyTest",
      "auth.json",
    );
  }
  return join(
    env.XDG_CONFIG_HOME ?? join(home, ".config"),
    "journeytest",
    "auth.json",
  );
}

export function formatMissingOAuthCredentialsMessage(
  provider: string,
  authPath: AuthPathResolution,
): string {
  const authDir = dirname(authPath.path);
  const customFileNote =
    basename(authPath.path) === "auth.json"
      ? ""
      : `\nThe Pi login CLI writes auth.json; move it to ${authPath.path} after login if you keep this custom filename.`;
  return (
    [
      `No OAuth credentials found for "${provider}" in ${authPath.path} (${authPathSourceLabel(authPath.source)}).`,
      `Create credentials with:`,
      `  mkdir -p "${authDir}"`,
      `  (cd "${authDir}" && npx @earendil-works/pi-ai login ${provider})`,
      `Override the auth file with --auth <path> or JOURNEYTEST_AUTH_PATH.`,
      `Existing local auth files are still supported at ${authPath.localPath}.`,
    ].join("\n") + customFileNote
  );
}

function authPathSourceLabel(source: AuthPathSource): string {
  if (source === "cli") {
    return "--auth";
  }
  if (source === "env") {
    return "JOURNEYTEST_AUTH_PATH";
  }
  if (source === "local") {
    return "existing local auth.json";
  }
  return "user config";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? error.code
        : undefined;
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function validateFiles(
  journeyPath: string,
  profilePath: string,
): Promise<{ issueCount: number }> {
  const profileFiles = await collectJsonFiles(resolve(profilePath));
  const journeyFiles = await collectJsonFiles(resolve(journeyPath));

  const profiles = new Map<string, TesterProfile>();
  let issueCount = 0;

  for (const file of profileFiles) {
    try {
      const profile = await readAndParseJsonFile(file, TesterProfileSchema);
      profiles.set(profile.id, profile);
      console.log(`profile ok: ${file}`);
    } catch (error) {
      issueCount++;
      console.error(formatError(file, error));
    }
  }

  for (const file of journeyFiles) {
    try {
      const journey = await readAndParseJsonFile(file, UserJourneySchema);
      const profile = profiles.get(journey.testerProfile);
      const issues: ValidationIssue[] = [...validateAllowedOrigins(journey)];
      if (!profile) {
        issues.push({
          path: "testerProfile",
          message: `No profile with id "${journey.testerProfile}" was loaded.`,
        });
      } else {
        issues.push(...validateJourneyProfileMatch(journey, profile));
      }

      if (issues.length > 0) {
        issueCount += issues.length;
        console.error(`journey invalid: ${file}`);
        for (const issue of issues) {
          console.error(`  ${issue.path}: ${issue.message}`);
        }
      } else {
        console.log(`journey ok: ${file}`);
      }
    } catch (error) {
      issueCount++;
      console.error(formatError(file, error));
    }
  }

  console.log(
    `Validated ${profileFiles.length} profile(s), ${journeyFiles.length} journey file(s).`,
  );
  if (issueCount > 0) {
    console.error(`${issueCount} validation issue(s).`);
  }
  return { issueCount };
}

export async function lintFiles(
  journeyPath: string,
  profilePath?: string,
): Promise<{ issueCount: number }> {
  const journeyFiles = await collectJsonFiles(resolve(journeyPath));
  const profileFiles = profilePath
    ? await collectJsonFiles(resolve(profilePath))
    : [];
  const profiles = new Map<string, TesterProfile>();
  let issueCount = 0;

  for (const file of profileFiles) {
    try {
      const profile = await readAndParseJsonFile(file, TesterProfileSchema);
      profiles.set(profile.id, profile);
      console.log(`profile lint ok: ${file}`);
    } catch (error) {
      issueCount++;
      console.error(formatError(file, error));
    }
  }

  for (const file of journeyFiles) {
    try {
      const journey = await readAndParseJsonFile(file, UserJourneySchema);
      const issues: LintIssue[] = [];
      const profile = profilePath
        ? profiles.get(journey.testerProfile)
        : undefined;

      if (profilePath && !profile) {
        issues.push({
          severity: "error",
          code: "missing-profile",
          path: "testerProfile",
          message: `No profile with id "${journey.testerProfile}" was loaded.`,
        });
      }
      issues.push(...lintUserJourney(journey, profile ? { profile } : {}));

      if (issues.length > 0) {
        issueCount += issues.length;
        console.error(`journey lint issues: ${file}`);
        for (const issue of issues) {
          console.error(`  ${formatLintIssue(issue)}`);
        }
      } else {
        console.log(`journey lint ok: ${file}`);
      }
    } catch (error) {
      issueCount++;
      console.error(formatError(file, error));
    }
  }

  console.log(
    `Linted ${profileFiles.length} profile(s), ${journeyFiles.length} journey file(s).`,
  );
  if (issueCount > 0) {
    console.error(`${issueCount} lint issue(s).`);
  }
  return { issueCount };
}

async function collectRunnableJourneys(
  journeyPath: string,
  profilePath: string,
): Promise<RunnableJourney[]> {
  const journeyFiles = await collectJsonFiles(journeyPath);
  const profiles = await loadProfiles(profilePath);
  const items: RunnableJourney[] = [];
  const issues: string[] = [];

  for (const journeyFile of journeyFiles) {
    try {
      const journey = await readAndParseJsonFile(
        journeyFile,
        UserJourneySchema,
      );
      const profile = profiles.get(journey.testerProfile);
      if (!profile) {
        issues.push(
          `${journeyFile}: no profile with id "${journey.testerProfile}" was loaded from ${profilePath}.`,
        );
        continue;
      }

      const validationIssues = [
        ...validateAllowedOrigins(journey),
        ...validateJourneyProfileMatch(journey, profile),
      ];
      if (validationIssues.length > 0) {
        for (const issue of validationIssues) {
          issues.push(`${journeyFile}: ${issue.path}: ${issue.message}`);
        }
        continue;
      }

      items.push({ journeyFile, journey, profile });
    } catch (error) {
      issues.push(formatError(journeyFile, error));
    }
  }

  if (issues.length > 0) {
    throw new Error(
      `Cannot run journeys until collection issues are fixed:\n${issues.join("\n")}`,
    );
  }

  return items;
}

async function loadProfiles(
  profilePath: string,
): Promise<Map<string, TesterProfile>> {
  const profileFiles = await collectJsonFiles(profilePath);
  const profiles = new Map<string, TesterProfile>();
  const issues: string[] = [];

  for (const file of profileFiles) {
    try {
      const profile = await readAndParseJsonFile(file, TesterProfileSchema);
      profiles.set(profile.id, profile);
    } catch (error) {
      issues.push(formatError(file, error));
    }
  }

  if (issues.length > 0) {
    throw new Error(`Cannot load tester profiles:\n${issues.join("\n")}`);
  }

  return profiles;
}

async function loadComparisonBaseline(
  compareToPath: string,
): Promise<ComparisonBaseline> {
  const info = await stat(compareToPath);
  if (info.isFile()) {
    return {
      sourcePath: compareToPath,
      kind: "run",
      runs: [await readAndParseJsonFile(compareToPath, RunResultSchema)],
    };
  }

  const runFiles = await collectRunJsonFiles(compareToPath);
  if (runFiles.length === 0) {
    throw new Error(
      `No run.json files found under --compare-to directory ${compareToPath}.`,
    );
  }

  return {
    sourcePath: compareToPath,
    kind: "suite",
    runs: await Promise.all(
      runFiles.map((runFile) => readAndParseJsonFile(runFile, RunResultSchema)),
    ),
  };
}

export async function loadRerunFailedSelection(
  rerunFailedPath: string,
): Promise<RerunFailedSelection> {
  const snapshots = await loadRunSnapshotsForSelection(rerunFailedPath);
  const unhealthyJourneyIds = [
    ...new Set(
      snapshots
        .filter((snapshot) => runHealth(snapshot) !== "passed")
        .map((snapshot) => snapshot.journeyId),
    ),
  ];
  if (unhealthyJourneyIds.length === 0) {
    throw new Error(
      `--rerun-failed found no unhealthy journeys in ${rerunFailedPath}.`,
    );
  }
  return {
    sourcePath: rerunFailedPath,
    unhealthyJourneyIds,
  };
}

async function loadRunSnapshotsForSelection(path: string): Promise<RunSnapshot[]> {
  const info = await stat(path);
  if (info.isFile()) {
    if (basename(path) === "history.json") {
      return readHistorySnapshots(path);
    }
    return [snapshotRun(await readAndParseJsonFile(path, RunResultSchema))];
  }

  const historyPath = join(path, "history.json");
  if (await pathExists(historyPath)) {
    return readHistorySnapshots(historyPath);
  }

  const runFiles = await collectRunJsonFiles(path);
  if (runFiles.length === 0) {
    throw new Error(
      `No run.json or history.json files found under --rerun-failed directory ${path}.`,
    );
  }

  return Promise.all(
    runFiles.map(async (runFile) =>
      snapshotRun(await readAndParseJsonFile(runFile, RunResultSchema)),
    ),
  );
}

async function readHistorySnapshots(path: string): Promise<RunSnapshot[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse history.json at ${path}: ${message}`);
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.runs)) {
    throw new Error(`history.json at ${path} must contain a runs array.`);
  }

  return parsed.runs.map((run, index) =>
    parseHistoryRunSnapshot(run, `${path}: runs[${index}]`),
  );
}

function parseHistoryRunSnapshot(value: unknown, label: string): RunSnapshot {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }

  const snapshot = {
    journeyId: readRequiredString(value, "journeyId", label),
    runId: readRequiredString(value, "runId", label),
    runStatus: readRequiredString(value, "runStatus", label),
    verdictStatus: readRequiredString(value, "verdictStatus", label),
    dataLifecycleStatus: readRequiredString(
      value,
      "dataLifecycleStatus",
      label,
    ),
    startedAt: readRequiredString(value, "startedAt", label),
    endedAt: readRequiredString(value, "endedAt", label),
    durationMs:
      typeof value.durationMs === "number" && Number.isFinite(value.durationMs)
        ? value.durationMs
        : 0,
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    ...(typeof value.dashboard === "string"
      ? { dashboard: value.dashboard }
      : {}),
    ...(typeof value.result === "string" ? { result: value.result } : {}),
  } as RunSnapshot;
  assertRunSnapshotEnums(snapshot, label);
  return snapshot;
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string.`);
  }
  return field;
}

function assertRunSnapshotEnums(snapshot: RunSnapshot, label: string): void {
  if (
    !["completed", "error", "cancelled", "blocked"].includes(
      snapshot.runStatus,
    )
  ) {
    throw new Error(`${label}.runStatus is not a valid run status.`);
  }
  if (
    !["passed", "failed", "blocked", "inconclusive", "none"].includes(
      snapshot.verdictStatus,
    )
  ) {
    throw new Error(`${label}.verdictStatus is not a valid verdict status.`);
  }
  if (
    !["passed", "failed", "blocked", "skipped", "none"].includes(
      snapshot.dataLifecycleStatus,
    )
  ) {
    throw new Error(
      `${label}.dataLifecycleStatus is not a valid data lifecycle status.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeSuiteArtifacts(
  outputDir: string,
  suiteRuns: SuiteDashboardRun[],
  comparisonBaseline?: ComparisonBaseline,
  selection?: SuiteSelectionSummary,
): Promise<{ dashboard: string; history: string }> {
  const suiteId =
    outputDir.split(/[\\/]/).at(-1) ?? `${isoTimestampForPath()}-run`;
  const generatedAt = new Date().toISOString();
  const suitePath = join(outputDir, "dashboard.html");
  const historyPath = join(outputDir, "history.json");
  const history = buildSuiteRunHistory({
    suiteId,
    generatedAt,
    runs: suiteRuns,
    ...(selection ? { selection } : {}),
    ...(comparisonBaseline
      ? {
          compareTo: {
            path: comparisonBaseline.sourcePath,
            kind: comparisonBaseline.kind,
            runs: comparisonBaseline.runs,
          },
        }
      : {}),
  });
  await writeHistoryArtifact(historyPath, history);
  await writeFile(
    suitePath,
    renderSuiteDashboard({
      suiteId,
      generatedAt,
      baseDir: outputDir,
      runs: suiteRuns,
      history,
      ...(selection ? { selection } : {}),
    }),
    "utf8",
  );
  return { dashboard: suitePath, history: historyPath };
}

async function writeHistoryArtifact(
  path: string,
  history: SuiteRunHistory,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(history, null, 2)}\n`, "utf8");
}

async function writeCliCiOutputs(options: {
  suiteRunId: string;
  suiteRuns: SuiteDashboardRun[];
  junitPath?: string;
  summaryJsonPath?: string;
  githubAnnotations?: boolean;
}): Promise<void> {
  if (
    !options.junitPath &&
    !options.summaryJsonPath &&
    !options.githubAnnotations
  ) {
    return;
  }

  const generatedAt = new Date().toISOString();
  const written = await writeCiReports({
    suiteName: options.suiteRunId,
    generatedAt,
    runs: options.suiteRuns,
    ...(options.junitPath ? { junitPath: resolve(options.junitPath) } : {}),
    ...(options.summaryJsonPath
      ? { summaryJsonPath: resolve(options.summaryJsonPath) }
      : {}),
  });

  if (written.junitPath) {
    console.log(`JUnit report: ${written.junitPath}`);
  }
  if (written.summaryJsonPath) {
    console.log(`Summary JSON: ${written.summaryJsonPath}`);
  }
  if (options.githubAnnotations) {
    emitGitHubAnnotations(options.suiteRuns, process.stderr);
  }
}

function installAppLifecycleSignalCleanup(
  controller: AppLifecycleController,
): () => void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  let handling = false;
  const handler = async (signal: NodeJS.Signals) => {
    if (handling) {
      return;
    }
    handling = true;
    console.error(`Received ${signal}; running app lifecycle cleanup.`);
    await controller.runCleanup().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`App lifecycle cleanup failed: ${message}`);
    });
    process.exit(signal === "SIGINT" ? 130 : 143);
  };

  for (const signal of signals) {
    process.once(signal, handler);
  }

  return () => {
    for (const signal of signals) {
      process.off(signal, handler);
    }
  };
}

function printRunResult(result: Awaited<ReturnType<typeof runJourney>>): void {
  console.log(`Run: ${result.runId}`);
  console.log(`Run status: ${result.runStatus}`);
  if (result.verdict) {
    console.log(`Verdict: ${result.verdict.status}`);
  }
  if (result.dataLifecycle) {
    console.log(`Data lifecycle: ${result.dataLifecycle.status}`);
  }
  console.log(`Dashboard: ${result.artifacts.dashboard}`);
  console.log(
    `Dashboard URL: ${pathToFileURL(result.artifacts.dashboard).href}`,
  );
  console.log(`Report: ${result.artifacts.report}`);
  console.log(`Result: ${result.artifacts.result}`);
}

async function collectJsonFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) {
    return path.endsWith(".json") ? [path] : [];
  }

  const entries = await readdir(path, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) {
        return collectJsonFiles(child);
      }
      return child.endsWith(".json") ? [child] : [];
    }),
  );

  return files.flat().sort();
}

async function collectRunJsonFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) {
    return basename(path) === "run.json" ? [path] : [];
  }

  const entries = await readdir(path, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const child = resolve(path, entry.name);
      if (entry.isDirectory()) {
        return collectRunJsonFiles(child);
      }
      return entry.name === "run.json" ? [child] : [];
    }),
  );

  return files.flat().sort();
}

function formatError(file: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${file} is invalid:\n${message}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
