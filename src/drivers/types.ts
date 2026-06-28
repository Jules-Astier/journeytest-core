import type { BrowserEnvironment } from "../core/schemas.js";

export interface BrowserStartOptions {
  runId: string;
  runDir: string;
  baseUrl: string;
  allowedOrigins: string[];
  sessionName?: string;
  tabLabel?: string;
  statePath?: string;
  headed?: boolean;
  browserEnvironment?: BrowserEnvironment;
}

export interface BrowserCommandResult<TDetails = unknown> {
  summary: string;
  stdout?: string;
  stderr?: string;
  details?: TDetails;
}

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface SnapshotOptions {
  interactive?: boolean;
  compact?: boolean;
  selector?: string;
  savePath?: string;
}

export interface ScreenshotOptions {
  path: string;
  full?: boolean;
  annotate?: boolean;
}

export interface ConsoleCaptureOptions {
  path: string;
  source?: "all" | "console" | "errors";
  clear?: boolean;
}

export interface NetworkCaptureOptions {
  path: string;
  filter?: string;
  resourceTypes?: string[];
  method?: string;
  status?: string;
  clear?: boolean;
}

export interface NetworkRecordingOptions {
  path: string;
}

export interface DomSnapshotOptions {
  savePath: string;
  maxElements?: number;
}

export interface UiChangeObservationOptions {
  timeoutMs?: number;
  quietMs?: number;
  maxChanges?: number;
}

export interface UiChangeRecord {
  index: number;
  elapsedMs: number;
  kind: string;
  selector?: string;
  role?: string;
  text?: string;
  previousText?: string;
  attributes?: Record<string, string | null>;
  boundingBox?: ElementBox;
  visible?: boolean;
  significance?: "high" | "medium" | "low";
  group?: string;
  summary?: string;
}

export interface UiChangeObservation {
  active: boolean;
  url: string;
  elapsedMs: number;
  lastChangeAgeMs: number;
  changes: UiChangeRecord[];
}

export type WaitOptions =
  | { kind: "duration"; ms: number }
  | { kind: "load"; state: "networkidle" | "domcontentloaded" }
  | { kind: "text"; text: string }
  | { kind: "url"; pattern: string }
  | { kind: "selector"; selector: string };

export interface ScrollOptions {
  direction: "up" | "down" | "left" | "right";
  amount?: number;
  target?: string;
}

export interface DragAndDropOptions {
  source: string;
  target: string;
}

export interface UploadOptions {
  target: string;
  files: string[];
}

export interface DownloadOptions {
  target: string;
  path: string;
}

export interface BrowserDriver {
  start(options: BrowserStartOptions): Promise<void>;
  startRecording(path: string): Promise<BrowserCommandResult>;
  stopRecording(): Promise<BrowserCommandResult>;
  open(url: string): Promise<BrowserCommandResult>;
  snapshot(
    options?: SnapshotOptions,
  ): Promise<BrowserCommandResult<{ path?: string }>>;
  scrollIntoView(target: string): Promise<BrowserCommandResult>;
  scroll(options: ScrollOptions): Promise<BrowserCommandResult>;
  hover(target: string): Promise<BrowserCommandResult>;
  dragAndDrop(options: DragAndDropOptions): Promise<BrowserCommandResult>;
  upload(options: UploadOptions): Promise<BrowserCommandResult>;
  download(
    options: DownloadOptions,
  ): Promise<BrowserCommandResult<{ path: string }>>;
  click(target: string): Promise<BrowserCommandResult>;
  fill(target: string, value: string): Promise<BrowserCommandResult>;
  type(target: string, value: string): Promise<BrowserCommandResult>;
  press(key: string): Promise<BrowserCommandResult>;
  wait(options: WaitOptions): Promise<BrowserCommandResult>;
  screenshot(
    options: ScreenshotOptions,
  ): Promise<BrowserCommandResult<{ path: string }>>;
  captureConsole?(
    options: ConsoleCaptureOptions,
  ): Promise<BrowserCommandResult<{ path: string }>>;
  captureNetwork?(
    options: NetworkCaptureOptions,
  ): Promise<BrowserCommandResult<{ path: string }>>;
  startNetworkRecording?(): Promise<BrowserCommandResult>;
  stopNetworkRecording?(
    options: NetworkRecordingOptions,
  ): Promise<BrowserCommandResult<{ path: string }>>;
  captureDomSnapshot?(
    options: DomSnapshotOptions,
  ): Promise<BrowserCommandResult<{ path: string }>>;
  startUiChangeObservation?(
    options?: UiChangeObservationOptions,
  ): Promise<BrowserCommandResult<UiChangeObservation>>;
  readUiChangeObservation?(): Promise<
    BrowserCommandResult<UiChangeObservation>
  >;
  stopUiChangeObservation?(): Promise<
    BrowserCommandResult<UiChangeObservation>
  >;
  getElementBox(selector: string): Promise<BrowserCommandResult<ElementBox>>;
  getViewport(): Promise<BrowserCommandResult<ViewportSize>>;
  getUrl(): Promise<string>;
  getTitle(): Promise<string>;
  close(): Promise<void>;
}
