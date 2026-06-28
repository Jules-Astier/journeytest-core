import type { BrowserDriver } from "../drivers/types.js";
import type { EventRecorder } from "../runner/events.js";
import type {
  AgentVerdict,
  TesterProfile,
  UserJourney,
} from "../core/schemas.js";

export interface DirectorModelInfo {
  provider: string;
  name: string;
}

export interface DirectorArtifacts {
  runDir: string;
  screenshotsDir: string;
  snapshotsDir: string;
  consoleDir: string;
  networkDir: string;
  uiChangesDir: string;
}

export interface UiChangeRecordingOptions {
  timeoutMs?: number;
  quietMs?: number;
  minWatchMs?: number;
  pollMs?: number;
  maxChanges?: number;
  maxScreenshots?: number;
  screenshots?: boolean;
  snapshots?: boolean;
  domSnapshots?: boolean;
}

export interface DirectorRunContext {
  journey: UserJourney;
  profile: TesterProfile;
  browser: BrowserDriver;
  recorder: EventRecorder;
  artifacts: DirectorArtifacts;
  uiChangeRecording?: boolean;
  uiChangeRecordingOptions?: UiChangeRecordingOptions;
}

export interface AgentDirector {
  readonly name: string;
  readonly model?: DirectorModelInfo;
  run(context: DirectorRunContext): Promise<AgentVerdict>;
}
