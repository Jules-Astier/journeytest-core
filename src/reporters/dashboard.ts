import { relative, sep } from "node:path";
import { buildRawActionBookmarks } from "../core/bookmarks.js";
import type {
  AgentVerdict,
  DataLifecycleExecution,
  DataLifecycleOperationResult,
  EvidenceReference,
  Finding,
  RunResult,
  TimelineEvent,
  VideoBookmark,
} from "../core/schemas.js";

export interface DashboardSnapshot {
  path: string;
  content: string;
}

export interface DashboardTextArtifact {
  path: string;
  content: string;
}

export interface RenderDashboardOptions {
  baseDir: string;
  snapshots?: DashboardSnapshot[];
  console?: DashboardTextArtifact[];
  network?: DashboardTextArtifact[];
  uiChanges?: DashboardTextArtifact[];
}

type DashboardTone = "pass" | "fail" | "block" | "note";

interface DashboardBookmark extends VideoBookmark {
  tone: DashboardTone;
}

interface MomentContext {
  id: string;
  bookmarkId: string;
  label: string;
  event?: {
    id: string;
    type: string;
    summary: string;
    elapsedMs: number;
    videoTimeMs?: number;
    data?: string;
  };
  assistantText?: string;
  nearbyEvents: Array<{
    id: string;
    type: string;
    summary: string;
    elapsedMs: number;
    videoTimeMs?: number;
  }>;
}

interface ClickMarker {
  id: string;
  eventId: string;
  timeMs: number;
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
  label: string;
}

export function renderHtmlDashboard(
  result: RunResult,
  options: RenderDashboardOptions,
): string {
  const bookmarks = collectBookmarks(result);
  const momentContexts = collectMomentContexts(bookmarks, result.timeline);
  const clickMarkers = collectClickMarkers(result.timeline);
  const snapshots = options.snapshots ?? [];
  const consoleArtifacts = options.console ?? [];
  const networkArtifacts = options.network ?? [];
  const uiChangeArtifacts = options.uiChanges ?? [];
  const videoHref = result.artifacts.video
    ? toHref(toRelativePath(options.baseDir, result.artifacts.video))
    : undefined;
  const artifactLinks = buildArtifactLinks(result, options.baseDir);
  const resultJson = JSON.stringify(result, null, 2);
  const dashboardData = safeScriptJson({
    runId: result.runId,
    bookmarks,
    moments: momentContexts,
    clickMarkers,
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>JourneyTest ${escapeHtml(result.journeyId)} Evidence Dashboard</title>
  <style>
    :root {
      --darkroom: #111412;
      --darkroom-2: #161a18;
      --darkroom-3: #1d221f;
      --bench: #252b27;
      --bench-line: rgba(210, 224, 213, 0.14);
      --bench-line-soft: rgba(210, 224, 213, 0.08);
      --paper: #eef3ea;
      --paper-dim: #a9b5ac;
      --paper-mute: #6f7b73;
      --tape-green: #7ee2a8;
      --fault-red: #ff807a;
      --amber-evidence: #f2c66f;
      --blueprint: #91b7ff;
      --control: #0d100e;
      --control-line: rgba(238, 243, 234, 0.18);
      --focus: rgba(126, 226, 168, 0.42);
      --radius: 8px;
      --unit: 8px;
      color-scheme: dark;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      background:
        linear-gradient(180deg, rgba(126, 226, 168, 0.03), transparent 380px),
        var(--darkroom);
      color: var(--paper);
      font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
      font-size: 14px;
      line-height: 1.45;
    }

    a {
      color: var(--blueprint);
      text-decoration: none;
    }

    a:hover { text-decoration: underline; }

    button {
      font: inherit;
      color: inherit;
    }

    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 72px minmax(0, 1fr);
    }

    .rail {
      border-right: 1px solid var(--bench-line-soft);
      padding: calc(var(--unit) * 2) var(--unit);
      display: flex;
      flex-direction: column;
      gap: calc(var(--unit) * 1.5);
      align-items: center;
      position: sticky;
      top: 0;
      height: 100vh;
      background: rgba(17, 20, 18, 0.72);
      backdrop-filter: blur(12px);
    }

    .mark {
      width: 42px;
      aspect-ratio: 1;
      border: 1px solid var(--bench-line);
      border-radius: var(--radius);
      display: grid;
      place-items: center;
      color: var(--tape-green);
      font-family: "SF Mono", "Menlo", monospace;
      font-weight: 700;
      background: var(--darkroom-2);
    }

    .rail a {
      width: 42px;
      aspect-ratio: 1;
      border: 1px solid transparent;
      border-radius: var(--radius);
      display: grid;
      place-items: center;
      color: var(--paper-mute);
      text-decoration: none;
    }

    .rail a:hover {
      color: var(--paper);
      border-color: var(--bench-line);
      background: var(--darkroom-2);
    }

    main {
      min-width: 0;
    }

    .topline {
      min-height: 88px;
      border-bottom: 1px solid var(--bench-line-soft);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: calc(var(--unit) * 3);
      align-items: end;
      padding: calc(var(--unit) * 3) calc(var(--unit) * 4);
    }

    h1 {
      margin: 0;
      font-size: clamp(24px, 3vw, 42px);
      line-height: 1.02;
      letter-spacing: 0;
      font-weight: 800;
    }

    .subtitle {
      margin-top: var(--unit);
      color: var(--paper-dim);
      max-width: 980px;
    }

    .meta-strip {
      display: flex;
      flex-wrap: wrap;
      gap: var(--unit);
      justify-content: flex-end;
      align-items: center;
    }

    .pill {
      border: 1px solid var(--bench-line);
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 12px;
      color: var(--paper-dim);
      background: rgba(255, 255, 255, 0.02);
      white-space: nowrap;
    }

    .pill strong { color: var(--paper); }
    .pill.pass { color: var(--tape-green); border-color: rgba(126, 226, 168, 0.34); }
    .pill.fail { color: var(--fault-red); border-color: rgba(255, 128, 122, 0.34); }
    .pill.block { color: var(--amber-evidence); border-color: rgba(242, 198, 111, 0.34); }

    .evidence-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.55fr);
      gap: calc(var(--unit) * 3);
      padding: calc(var(--unit) * 3) calc(var(--unit) * 4);
      align-items: start;
    }

    .video-bay,
    .bookmark-bay,
    .section,
    .artifact-row,
    .finding,
    .criterion {
      border: 1px solid var(--bench-line);
      background: linear-gradient(180deg, var(--darkroom-2), var(--darkroom-3));
      border-radius: var(--radius);
    }

    .video-bay {
      overflow: hidden;
      min-height: 460px;
    }

    .video-head,
    .panel-head {
      min-height: 48px;
      border-bottom: 1px solid var(--bench-line-soft);
      padding: calc(var(--unit) * 1.5) calc(var(--unit) * 2);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: calc(var(--unit) * 2);
    }

    .panel-title {
      font-size: 12px;
      color: var(--paper-dim);
      text-transform: uppercase;
      font-weight: 700;
    }

    .video-wrap {
      background: #070807;
      min-height: 410px;
      display: grid;
      place-items: center;
      position: relative;
    }

    .video-stage {
      width: 100%;
      position: relative;
      display: grid;
      place-items: center;
    }

    video {
      width: 100%;
      max-height: 72vh;
      background: #070807;
      display: block;
    }

    .click-layer {
      position: absolute;
      pointer-events: none;
      overflow: hidden;
    }

    .click-marker {
      position: absolute;
      width: 30px;
      aspect-ratio: 1;
      border: 2px solid var(--amber-evidence);
      border-radius: 999px;
      transform: translate(-50%, -50%) scale(0.72);
      opacity: 0;
      box-shadow: 0 0 0 6px rgba(242, 198, 111, 0.16);
      transition: opacity 120ms ease, transform 180ms ease;
    }

    .click-marker::after {
      content: "";
      position: absolute;
      inset: 9px;
      border-radius: inherit;
      background: var(--amber-evidence);
    }

    .click-marker.visible {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }

    .no-video {
      color: var(--paper-mute);
      max-width: 440px;
      text-align: center;
      padding: calc(var(--unit) * 4);
    }

    .bookmark-bay {
      max-height: calc(100vh - 136px);
      overflow: hidden;
      position: sticky;
      top: 24px;
    }

    .bookmark-list {
      max-height: min(54vh, calc(100vh - 340px));
      overflow: auto;
      padding: var(--unit);
    }

    .bookmark {
      width: 100%;
      display: grid;
      grid-template-columns: 68px minmax(0, 1fr);
      gap: var(--unit);
      align-items: start;
      text-align: left;
      border: 1px solid transparent;
      border-radius: 6px;
      background: transparent;
      padding: var(--unit);
      cursor: pointer;
    }

    .bookmark:hover,
    .bookmark.active {
      background: rgba(238, 243, 234, 0.04);
      border-color: var(--bench-line);
    }

    .bookmark:focus-visible,
    .artifact-link:focus-visible,
    summary:focus-visible {
      outline: 2px solid var(--focus);
      outline-offset: 2px;
    }

    .stamp {
      font-family: "SF Mono", "Menlo", monospace;
      color: var(--amber-evidence);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
      padding-top: 2px;
    }

    .bookmark-title {
      font-weight: 700;
      color: var(--paper);
      overflow-wrap: anywhere;
    }

    .bookmark-detail {
      margin-top: 2px;
      color: var(--paper-mute);
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .bookmark.pass .stamp { color: var(--tape-green); }
    .bookmark.fail .stamp { color: var(--fault-red); }
    .bookmark.block .stamp { color: var(--amber-evidence); }

    .moment-panel {
      border-top: 1px solid var(--bench-line-soft);
      padding: calc(var(--unit) * 1.5) calc(var(--unit) * 2);
      min-height: 156px;
      background: rgba(0, 0, 0, 0.1);
    }

    .moment-label {
      color: var(--paper);
      font-weight: 800;
      overflow-wrap: anywhere;
    }

    .moment-meta,
    .moment-events {
      margin-top: 6px;
      color: var(--paper-mute);
      font-family: "SF Mono", "Menlo", monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .moment-text {
      margin-top: var(--unit);
      color: var(--paper-dim);
      max-height: 132px;
      overflow: auto;
      white-space: pre-wrap;
    }

    .content {
      padding: 0 calc(var(--unit) * 4) calc(var(--unit) * 6);
      display: grid;
      gap: calc(var(--unit) * 3);
    }

    .section {
      overflow: hidden;
    }

    .section-body {
      padding: calc(var(--unit) * 2);
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: var(--unit);
    }

    .metric {
      border: 1px solid var(--bench-line-soft);
      border-radius: 6px;
      padding: calc(var(--unit) * 1.5);
      background: rgba(0, 0, 0, 0.12);
      min-width: 0;
    }

    .metric-label {
      color: var(--paper-mute);
      font-size: 12px;
      font-weight: 700;
    }

    .metric-value {
      margin-top: 4px;
      color: var(--paper);
      font-family: "SF Mono", "Menlo", monospace;
      font-size: 13px;
      overflow-wrap: anywhere;
    }

    .criteria-grid,
    .findings-grid,
    .artifact-grid,
    .snapshot-grid {
      display: grid;
      gap: var(--unit);
    }

    .criterion,
    .finding {
      padding: calc(var(--unit) * 1.5);
      background: rgba(0, 0, 0, 0.12);
    }

    .criterion {
      display: grid;
      grid-template-columns: 150px minmax(0, 1fr);
      gap: calc(var(--unit) * 2);
    }

    .criterion-id,
    .finding-meta {
      font-family: "SF Mono", "Menlo", monospace;
      color: var(--paper-mute);
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .criterion-result {
      margin-top: 6px;
      display: inline-flex;
      width: fit-content;
    }

    .criterion-text,
    .finding-title {
      font-weight: 700;
      color: var(--paper);
    }

    .criterion-explanation,
    .finding-description,
    .evidence-text {
      margin-top: 6px;
      color: var(--paper-dim);
    }

    .artifact-grid {
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }

    .artifact-link {
      min-height: 80px;
      border: 1px solid var(--bench-line);
      border-radius: 6px;
      padding: calc(var(--unit) * 1.5);
      background: rgba(0, 0, 0, 0.12);
      text-decoration: none;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .artifact-kind {
      color: var(--paper);
      font-weight: 700;
    }

    .artifact-path {
      color: var(--paper-mute);
      font-family: "SF Mono", "Menlo", monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .screenshot-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: var(--unit);
    }

    .screenshot-grid a {
      border: 1px solid var(--bench-line);
      border-radius: 6px;
      overflow: hidden;
      background: rgba(0, 0, 0, 0.16);
      text-decoration: none;
    }

    .screenshot-grid img {
      width: 100%;
      display: block;
      aspect-ratio: 16 / 10;
      object-fit: cover;
      background: #070807;
    }

    .caption {
      padding: var(--unit);
      color: var(--paper-mute);
      font-family: "SF Mono", "Menlo", monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .ui-change-list {
      display: grid;
      gap: calc(var(--unit) * 1.5);
    }

    .ui-change-card {
      border: 1px solid var(--bench-line);
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.14);
      overflow: hidden;
    }

    .ui-change-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--unit);
      padding: calc(var(--unit) * 1.25) calc(var(--unit) * 1.5);
      border-bottom: 1px solid var(--bench-line-soft);
    }

    .ui-change-title {
      color: var(--paper);
      font-weight: 700;
    }

    .ui-change-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .ui-change-body {
      display: grid;
      gap: calc(var(--unit) * 1.5);
      padding: calc(var(--unit) * 1.5);
    }

    .ui-change-media {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: var(--unit);
    }

    .ui-change-thumb,
    .ui-change-file {
      border: 1px solid var(--bench-line);
      border-radius: 6px;
      overflow: hidden;
      background: rgba(0, 0, 0, 0.16);
      text-decoration: none;
    }

    .ui-change-thumb img {
      width: 100%;
      display: block;
      aspect-ratio: 16 / 10;
      object-fit: cover;
      background: #070807;
    }

    details {
      border: 1px solid var(--bench-line);
      border-radius: 6px;
      background: rgba(0, 0, 0, 0.14);
      overflow: hidden;
    }

    summary {
      cursor: pointer;
      padding: calc(var(--unit) * 1.25) calc(var(--unit) * 1.5);
      color: var(--paper);
      font-weight: 700;
    }

    pre {
      margin: 0;
      border-top: 1px solid var(--bench-line-soft);
      padding: calc(var(--unit) * 1.5);
      color: #dbe5dc;
      background: var(--control);
      overflow: auto;
      max-height: 440px;
      font-family: "SF Mono", "Menlo", monospace;
      font-size: 12px;
      line-height: 1.5;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    th,
    td {
      border-bottom: 1px solid var(--bench-line-soft);
      padding: 9px 8px;
      text-align: left;
      vertical-align: top;
    }

    th {
      color: var(--paper-mute);
      font-size: 12px;
      font-weight: 700;
    }

    td.time {
      color: var(--amber-evidence);
      font-family: "SF Mono", "Menlo", monospace;
      white-space: nowrap;
    }

    .seek-inline {
      border: 1px solid var(--control-line);
      border-radius: 5px;
      background: var(--control);
      padding: 3px 7px;
      cursor: pointer;
      color: var(--paper-dim);
      font-family: "SF Mono", "Menlo", monospace;
      font-size: 12px;
    }

    .seek-inline:hover {
      color: var(--paper);
      border-color: var(--bench-line);
    }

    @media (max-width: 980px) {
      .shell { grid-template-columns: 1fr; }
      .rail { display: none; }
      .topline,
      .evidence-grid,
      .content { padding-left: calc(var(--unit) * 2); padding-right: calc(var(--unit) * 2); }
      .topline { grid-template-columns: 1fr; align-items: start; }
      .meta-strip { justify-content: flex-start; }
      .evidence-grid { grid-template-columns: 1fr; }
      .bookmark-bay { position: static; max-height: none; }
      .bookmark-list { max-height: 360px; }
      .summary-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .criterion { grid-template-columns: 1fr; }
    }

    @media (max-width: 560px) {
      .summary-grid { grid-template-columns: 1fr; }
      .video-bay { min-height: 300px; }
      .video-wrap { min-height: 260px; }
    }
  </style>
</head>
<body>
  <script>window.__JOURNEYTEST_DASHBOARD__ = ${dashboardData};</script>
  <div class="shell">
    <nav class="rail" aria-label="Dashboard sections">
      <div class="mark">JT</div>
      <a href="#video" title="Video">V</a>
      <a href="#verdict" title="Verdict">R</a>
      <a href="#data-lifecycle" title="Data Lifecycle">D</a>
      <a href="#timeline" title="Timeline">T</a>
      <a href="#artifacts" title="Artifacts">A</a>
    </nav>

    <main>
      <header class="topline">
        <div>
          <h1>${escapeHtml(result.journeyId)}</h1>
          <div class="subtitle">${escapeHtml(result.verdict?.summary ?? result.error?.message ?? "Run evidence dashboard")}</div>
        </div>
        <div class="meta-strip">
          ${renderStatusPill("Run", result.runStatus, runTone(result.runStatus))}
          ${result.verdict ? renderStatusPill("Verdict", result.verdict.status, verdictTone(result.verdict.status)) : ""}
          ${result.dataLifecycle ? renderStatusPill("Data", result.dataLifecycle.status, lifecycleTone(result.dataLifecycle.status)) : ""}
          ${result.verdict ? renderStatusPill("Confidence", result.verdict.confidence, "note") : ""}
          ${renderStatusPill("Duration", formatDuration(result.durationMs), "note")}
        </div>
      </header>

      <section id="video" class="evidence-grid" aria-label="Video and bookmarks">
        <div class="video-bay">
          <div class="video-head">
            <div class="panel-title">Run Video</div>
            <div class="pill"><strong>${escapeHtml(result.runId)}</strong></div>
          </div>
          <div class="video-wrap">
            ${
              videoHref
                ? `<div class="video-stage">
                    <video data-video controls preload="metadata" src="${videoHref}"></video>
                    <div class="click-layer" data-click-layer aria-hidden="true">
                      <div class="click-marker" data-click-marker></div>
                    </div>
                  </div>`
                : `<div class="no-video">No video artifact was recorded for this run.</div>`
            }
          </div>
        </div>

        <aside class="bookmark-bay" aria-label="Video bookmarks">
          <div class="panel-head">
            <div class="panel-title">Bookmarks</div>
            <div class="pill"><strong>${bookmarks.length}</strong> marks</div>
          </div>
          <div class="bookmark-list">
            ${
              bookmarks.length
                ? bookmarks.map(renderBookmark).join("")
                : `<div class="no-video">No timestamped UI actions were recorded.</div>`
            }
          </div>
          <div class="moment-panel" data-moment-panel>
            ${renderMomentContext(momentContexts[0])}
          </div>
        </aside>
      </section>

      <div class="content">
        <section class="section" id="verdict">
          <div class="panel-head">
            <div class="panel-title">Agent Verdict</div>
            ${
              result.model
                ? `<div class="pill">${escapeHtml(result.model.provider)} / <strong>${escapeHtml(result.model.name)}</strong></div>`
                : ""
            }
          </div>
          <div class="section-body">
            ${renderOverview(result)}
          </div>
        </section>

        ${renderCriteriaSection(result.verdict)}
        ${renderFindingsSection("Blockers", result.verdict?.blockers ?? [])}
        ${renderFindingsSection("UX Findings", result.verdict?.uxFindings ?? [])}
        ${renderFindingsSection("Suggested Improvements", result.verdict?.suggestedImprovements ?? [])}
        ${renderDataLifecycleSection(result.dataLifecycle)}
        ${renderScreenshots(result, options.baseDir)}
        ${renderSnapshots(snapshots, options.baseDir)}
        ${renderTextArtifactsSection("Console Evidence", consoleArtifacts, options.baseDir)}
        ${renderTextArtifactsSection("Network Evidence", networkArtifacts, options.baseDir)}
        ${renderUiChangeTimelines(uiChangeArtifacts, options.baseDir)}

        <section class="section" id="timeline">
          <div class="panel-head">
            <div class="panel-title">Timeline</div>
            <div class="pill"><strong>${result.timeline.length}</strong> events</div>
          </div>
          <div class="section-body">
            ${renderTimeline(result.timeline)}
          </div>
        </section>

        <section class="section" id="artifacts">
          <div class="panel-head">
            <div class="panel-title">Collateral</div>
            <div class="pill">Generated files</div>
          </div>
          <div class="section-body">
            <div class="artifact-grid">
              ${artifactLinks.map(renderArtifactLink).join("")}
            </div>
          </div>
        </section>

        <section class="section">
          <div class="panel-head">
            <div class="panel-title">Raw Data</div>
            <div class="pill">Embedded</div>
          </div>
          <div class="section-body">
            <details>
              <summary>Run JSON</summary>
              <pre>${escapeHtml(resultJson)}</pre>
            </details>
          </div>
        </section>
      </div>
    </main>
  </div>

  <script>
    (() => {
      const video = document.querySelector("[data-video]");
      const seekButtons = Array.from(document.querySelectorAll("[data-seek-ms]"));
      const bookmarks = Array.from(document.querySelectorAll("[data-bookmark-id][data-seek-ms]"));
      const momentPanel = document.querySelector("[data-moment-panel]");
      const moments = new Map((window.__JOURNEYTEST_DASHBOARD__?.moments ?? []).map((moment) => [moment.bookmarkId, moment]));
      const clickMarkers = window.__JOURNEYTEST_DASHBOARD__?.clickMarkers ?? [];
      const clickLayer = document.querySelector("[data-click-layer]");
      const clickMarker = document.querySelector("[data-click-marker]");
      let clickMarkerTimeout = null;

      function setActive(target) {
        bookmarks.forEach((button) => button.classList.toggle("active", button === target));
        renderMoment(target.getAttribute("data-bookmark-id"));
        showNearestClickMarker(Number(target.getAttribute("data-seek-ms")), 900);
      }

      function setText(parent, selector, value) {
        const element = parent.querySelector(selector);
        if (element) element.textContent = value || "";
      }

      function renderMoment(bookmarkId) {
        if (!momentPanel || !bookmarkId) return;
        const moment = moments.get(bookmarkId);
        if (!moment) return;
        setText(momentPanel, "[data-moment-label]", moment.label);
        const eventMeta = moment.event
          ? [
              moment.event.videoTimeMs === undefined ? "" : formatTimestamp(moment.event.videoTimeMs),
              moment.event.type,
              moment.event.id,
            ].filter(Boolean).join(" · ")
          : "";
        setText(momentPanel, "[data-moment-meta]", eventMeta);
        setText(momentPanel, "[data-moment-text]", moment.assistantText || "");
        setText(
          momentPanel,
          "[data-moment-events]",
          (moment.nearbyEvents || []).map((event) => formatTimestamp(event.elapsedMs) + " " + event.type + " " + event.summary).join("\\n"),
        );
      }

      function syncClickLayer() {
        if (!video || !clickLayer) return;
        const videoRect = video.getBoundingClientRect();
        const wrapRect = video.parentElement.getBoundingClientRect();
        clickLayer.style.left = (videoRect.left - wrapRect.left) + "px";
        clickLayer.style.top = (videoRect.top - wrapRect.top) + "px";
        clickLayer.style.width = videoRect.width + "px";
        clickLayer.style.height = videoRect.height + "px";
      }

      function showClickMarker(marker) {
        if (!clickLayer || !clickMarker || !marker) return;
        syncClickLayer();
        const left = Math.max(0, Math.min(100, (marker.x / marker.viewportWidth) * 100));
        const top = Math.max(0, Math.min(100, (marker.y / marker.viewportHeight) * 100));
        clickMarker.style.left = left + "%";
        clickMarker.style.top = top + "%";
        clickMarker.classList.add("visible");
        if (clickMarkerTimeout) clearTimeout(clickMarkerTimeout);
        clickMarkerTimeout = setTimeout(() => clickMarker.classList.remove("visible"), 700);
      }

      function showNearestClickMarker(timeMs, windowMs) {
        if (Number.isNaN(timeMs)) return;
        let nearest = null;
        for (const marker of clickMarkers) {
          const distance = Math.abs(marker.timeMs - timeMs);
          if (distance <= windowMs && (!nearest || distance < Math.abs(nearest.timeMs - timeMs))) {
            nearest = marker;
          }
        }
        showClickMarker(nearest);
      }

      seekButtons.forEach((button) => {
        button.addEventListener("click", () => {
          const ms = Number(button.getAttribute("data-seek-ms"));
          if (!video || Number.isNaN(ms)) return;
          video.currentTime = ms / 1000;
          video.scrollIntoView({ behavior: "smooth", block: "center" });
          video.focus({ preventScroll: true });
          showNearestClickMarker(ms, 900);
          if (button.hasAttribute("data-bookmark-id")) setActive(button);
        });
      });

      if (video) {
        video.addEventListener("timeupdate", () => {
          const currentMs = video.currentTime * 1000;
          let active = null;
          for (const button of bookmarks) {
            const ms = Number(button.getAttribute("data-seek-ms"));
            if (!Number.isNaN(ms) && ms <= currentMs + 500) {
              active = button;
            }
          }
          if (active) setActive(active);
          showNearestClickMarker(currentMs, 180);
        });
        video.addEventListener("loadedmetadata", syncClickLayer);
        window.addEventListener("resize", syncClickLayer);
      }

      function formatTimestamp(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        const millis = Math.floor(ms % 1000);
        return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0") + "." + String(millis).padStart(3, "0");
      }
    })();
  </script>
</body>
</html>`;
}

function renderOverview(result: RunResult): string {
  return `<div class="summary-grid">
    ${renderMetric("Run ID", result.runId)}
    ${renderMetric("Journey", result.journeyId)}
    ${renderMetric("Tester", result.testerProfileId)}
    ${renderMetric("Started", new Date(result.startedAt).toLocaleString())}
    ${renderMetric("Ended", new Date(result.endedAt).toLocaleString())}
    ${renderMetric("Duration", formatDuration(result.durationMs))}
    ${renderMetric("Run Status", result.runStatus)}
    ${renderMetric("Verdict", result.verdict?.status ?? "none")}
    ${result.browserEnvironment ? renderMetric("Browser", formatBrowserEnvironment(result.browserEnvironment)) : ""}
    ${result.dataLifecycle ? renderMetric("Data Lifecycle", result.dataLifecycle.status) : ""}
    ${result.videoProcessing ? renderMetric("Video Clips", formatVideoClipMetric(result.videoProcessing)) : ""}
  </div>`;
}

function formatVideoClipMetric(processing: NonNullable<RunResult["videoProcessing"]>): string {
  if (processing.actionClipCount !== undefined) {
    return `${processing.actionClipCount} ${processing.actionClipStitched ? "stitched" : "clips"}`;
  }

  return "none";
}

function formatBrowserEnvironment(
  environment: NonNullable<RunResult["browserEnvironment"]>,
): string {
  const parts = [
    environment.device,
    environment.viewport
      ? `${environment.viewport.width}x${environment.viewport.height}${
          environment.viewport.deviceScaleFactor === undefined
            ? ""
            : `@${environment.viewport.deviceScaleFactor}`
        }`
      : undefined,
  ].filter(Boolean);
  return parts.join(" / ");
}

function renderMetric(label: string, value: string): string {
  return `<div class="metric">
    <div class="metric-label">${escapeHtml(label)}</div>
    <div class="metric-value">${escapeHtml(value)}</div>
  </div>`;
}

function renderCriteriaSection(verdict: AgentVerdict | undefined): string {
  if (!verdict) {
    return "";
  }

  return `<section class="section">
    <div class="panel-head">
      <div class="panel-title">Criteria Assessment</div>
      <div class="pill"><strong>${verdict.criteria.length}</strong> criteria</div>
    </div>
    <div class="section-body">
      <div class="criteria-grid">
        ${verdict.criteria.map(renderCriterion).join("")}
      </div>
    </div>
  </section>`;
}

function renderCriterion(criterion: AgentVerdict["criteria"][number]): string {
  return `<article class="criterion">
    <div>
      <div class="criterion-id">${escapeHtml(criterion.id)}</div>
      ${renderStatusPill(criterion.result, criterion.result, criterionTone(criterion.result), "criterion-result")}
    </div>
    <div>
      <div class="criterion-text">${escapeHtml(criterion.explanation)}</div>
      ${criterion.evidence ? `<div class="evidence-text">${escapeHtml(formatEvidence(criterion.evidence))}</div>` : ""}
    </div>
  </article>`;
}

function renderFindingsSection(title: string, findings: Finding[]): string {
  return `<section class="section">
    <div class="panel-head">
      <div class="panel-title">${escapeHtml(title)}</div>
      <div class="pill"><strong>${findings.length}</strong> items</div>
    </div>
    <div class="section-body">
      ${
        findings.length
          ? `<div class="findings-grid">${findings.map(renderFinding).join("")}</div>`
          : `<div class="metric"><div class="metric-value">None recorded.</div></div>`
      }
    </div>
  </section>`;
}

function renderDataLifecycleSection(
  lifecycle: DataLifecycleExecution | undefined,
): string {
  if (!lifecycle) {
    return "";
  }

  const operations = [
    ...lifecycle.setup,
    ...lifecycle.preflight,
    ...lifecycle.postconditions,
    ...lifecycle.cleanup,
  ];

  return `<section class="section" id="data-lifecycle">
    <div class="panel-head">
      <div class="panel-title">Data Lifecycle</div>
      ${renderStatusPill("Status", lifecycle.status, lifecycleTone(lifecycle.status))}
    </div>
    <div class="section-body">
      <div class="summary-grid">
        ${renderMetric("Scope", lifecycle.scope)}
        ${renderMetric("Environment", lifecycle.environment)}
        ${renderMetric("Namespace", lifecycle.namespace)}
        ${renderMetric("Operations", String(operations.length))}
      </div>
      ${operations.length ? renderLifecycleTable(operations) : `<div class="metric"><div class="metric-value">No operations recorded.</div></div>`}
    </div>
  </section>`;
}

function renderLifecycleTable(
  operations: DataLifecycleOperationResult[],
): string {
  return `<table>
    <thead>
      <tr>
        <th>Phase</th>
        <th>Operation</th>
        <th>Function</th>
        <th>Status</th>
        <th>Checks</th>
        <th>Error</th>
      </tr>
    </thead>
    <tbody>
      ${operations.map(renderLifecycleRow).join("")}
    </tbody>
  </table>`;
}

function renderLifecycleRow(operation: DataLifecycleOperationResult): string {
  return `<tr>
    <td>${escapeHtml(operation.phase)}</td>
    <td>${escapeHtml(operation.id)}</td>
    <td>${escapeHtml(operation.function)}</td>
    <td>${renderStatusPill(operation.status, operation.status, operation.status === "passed" ? "pass" : "fail")}</td>
    <td>${escapeHtml(formatLifecycleChecks(operation))}</td>
    <td>${escapeHtml(operation.error?.message ?? "")}</td>
  </tr>`;
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

function renderFinding(finding: Finding): string {
  return `<article class="finding">
    <div class="finding-meta">${escapeHtml(finding.severity)} / ${escapeHtml(finding.category)} / ${escapeHtml(finding.id)}</div>
    <div class="finding-title">${escapeHtml(finding.title)}</div>
    <div class="finding-description">${escapeHtml(finding.description)}</div>
    ${finding.recommendation ? `<div class="evidence-text">Recommendation: ${escapeHtml(finding.recommendation)}</div>` : ""}
    ${finding.evidence ? `<div class="evidence-text">${escapeHtml(formatEvidence(finding.evidence))}</div>` : ""}
  </article>`;
}

function renderScreenshots(result: RunResult, baseDir: string): string {
  if (result.artifacts.screenshots.length === 0) {
    return "";
  }

  return `<section class="section">
    <div class="panel-head">
      <div class="panel-title">Screenshots</div>
      <div class="pill"><strong>${result.artifacts.screenshots.length}</strong> files</div>
    </div>
    <div class="section-body">
      <div class="screenshot-grid">
        ${result.artifacts.screenshots
          .map((path) => {
            const rel = toRelativePath(baseDir, path);
            const href = toHref(rel);
            return `<a href="${href}" target="_blank" rel="noreferrer">
              <img src="${href}" alt="${escapeAttr(rel)}">
              <div class="caption">${escapeHtml(rel)}</div>
            </a>`;
          })
          .join("")}
      </div>
    </div>
  </section>`;
}

function renderSnapshots(
  snapshots: DashboardSnapshot[],
  baseDir: string,
): string {
  if (snapshots.length === 0) {
    return "";
  }

  return renderTextArtifactsSection("Snapshots", snapshots, baseDir);
}

function renderTextArtifactsSection(
  title: string,
  artifacts: DashboardTextArtifact[],
  baseDir: string,
): string {
  if (artifacts.length === 0) {
    return "";
  }

  return `<section class="section">
    <div class="panel-head">
      <div class="panel-title">${escapeHtml(title)}</div>
      <div class="pill"><strong>${artifacts.length}</strong> files</div>
    </div>
    <div class="section-body snapshot-grid">
      ${artifacts
        .map((artifact, index) => {
          const rel = toRelativePath(baseDir, artifact.path);
          return `<details ${index === 0 ? "open" : ""}>
            <summary>${escapeHtml(rel)}</summary>
            <pre>${escapeHtml(artifact.content)}</pre>
          </details>`;
        })
        .join("")}
    </div>
  </section>`;
}

function renderUiChangeTimelines(
  artifacts: DashboardTextArtifact[],
  baseDir: string,
): string {
  if (artifacts.length === 0) {
    return "";
  }

  return `<section class="section">
    <div class="panel-head">
      <div class="panel-title">UI Change Timelines</div>
      <div class="pill"><strong>${artifacts.length}</strong> files</div>
    </div>
    <div class="section-body ui-change-list">
      ${artifacts.map((artifact) => renderUiChangeTimeline(artifact, baseDir)).join("")}
    </div>
  </section>`;
}

function renderUiChangeTimeline(
  artifact: DashboardTextArtifact,
  baseDir: string,
): string {
  const parsed = parseUiChangeArtifact(artifact.content);
  const rel = toRelativePath(baseDir, artifact.path);
  if (!parsed) {
    return `<details open>
      <summary>${escapeHtml(rel)}</summary>
      <pre>${escapeHtml(artifact.content)}</pre>
    </details>`;
  }

  const action = asRecord(parsed.action);
  const navigation = asRecord(parsed.navigation);
  const screenshots = asRecord(parsed.screenshots);
  const snapshots = asRecord(parsed.snapshots);
  const domSnapshots = asRecord(parsed.domSnapshots);
  const changes = Array.isArray(parsed.significantChanges)
    ? parsed.significantChanges
    : Array.isArray(parsed.changes)
      ? parsed.changes
      : [];
  const actionKind = stringValue(action?.kind) ?? "action";
  const target = stringValue(action?.target);
  const changeCount =
    numberValue(parsed.significantChangeCount) ??
    numberValue(parsed.changeCount) ??
    changes.length;
  const title = `${actionKind}${target ? ` ${target}` : ""}`;
  const rawHref = toHref(rel);

  return `<article class="ui-change-card">
    <div class="ui-change-head">
      <div>
        <div class="ui-change-title">${escapeHtml(title)}</div>
        <div class="artifact-path">${escapeHtml(rel)}</div>
      </div>
      <div class="ui-change-meta">
        <span class="pill note"><strong>${changeCount}</strong> significant</span>
        ${
          navigation?.changed
            ? `<span class="pill note"><strong>route</strong> changed</span>`
            : ""
        }
        <a class="seek-inline" href="${escapeAttr(rawHref)}" target="_blank" rel="noreferrer">raw JSON</a>
      </div>
    </div>
    <div class="ui-change-body">
      ${renderUiChangeMedia(screenshots, snapshots, domSnapshots, baseDir)}
      ${renderUiChangeNavigation(navigation)}
      ${renderUiChangeTable(changes)}
    </div>
  </article>`;
}

function renderUiChangeMedia(
  screenshots: Record<string, unknown> | undefined,
  snapshots: Record<string, unknown> | undefined,
  domSnapshots: Record<string, unknown> | undefined,
  baseDir: string,
): string {
  const media: string[] = [];
  const before = stringValue(screenshots?.before);
  const after = stringValue(screenshots?.after);
  const changeShots = Array.isArray(screenshots?.changes)
    ? screenshots?.changes.filter(
        (item): item is string => typeof item === "string",
      )
    : [];

  if (before) {
    media.push(renderUiChangeThumb("before", before, baseDir));
  }
  for (const [index, path] of changeShots.entries()) {
    media.push(renderUiChangeThumb(`change ${index + 1}`, path, baseDir));
  }
  if (after) {
    media.push(renderUiChangeThumb("after", after, baseDir));
  }

  const beforeSnapshot = stringValue(snapshots?.before);
  const afterSnapshot = stringValue(snapshots?.after);
  if (beforeSnapshot) {
    media.push(renderUiChangeFile("before snapshot", beforeSnapshot, baseDir));
  }
  if (afterSnapshot) {
    media.push(renderUiChangeFile("after snapshot", afterSnapshot, baseDir));
  }
  const beforeDomSnapshot = stringValue(domSnapshots?.before);
  const afterDomSnapshot = stringValue(domSnapshots?.after);
  if (beforeDomSnapshot) {
    media.push(renderUiChangeFile("before DOM", beforeDomSnapshot, baseDir));
  }
  if (afterDomSnapshot) {
    media.push(renderUiChangeFile("after DOM", afterDomSnapshot, baseDir));
  }

  if (media.length === 0) {
    return "";
  }

  return `<div class="ui-change-media">${media.join("")}</div>`;
}

function renderUiChangeThumb(
  label: string,
  path: string,
  baseDir: string,
): string {
  const rel = toRelativePath(baseDir, path);
  const href = toHref(rel);
  return `<a class="ui-change-thumb" href="${escapeAttr(href)}" target="_blank" rel="noreferrer">
    <img src="${escapeAttr(href)}" alt="${escapeAttr(label)}">
    <div class="caption">${escapeHtml(label)} - ${escapeHtml(rel)}</div>
  </a>`;
}

function renderUiChangeFile(
  label: string,
  path: string,
  baseDir: string,
): string {
  const rel = toRelativePath(baseDir, path);
  const href = toHref(rel);
  return `<a class="ui-change-file" href="${escapeAttr(href)}" target="_blank" rel="noreferrer">
    <div class="caption">${escapeHtml(label)} - ${escapeHtml(rel)}</div>
  </a>`;
}

function renderUiChangeNavigation(
  navigation: Record<string, unknown> | undefined,
): string {
  if (!navigation?.changed) {
    return "";
  }

  return `<div class="evidence-text">Navigation: ${escapeHtml(stringValue(navigation.beforeUrl) ?? "")} -> ${escapeHtml(stringValue(navigation.afterUrl) ?? "")}</div>`;
}

function renderUiChangeTable(changes: unknown[]): string {
  if (changes.length === 0) {
    return `<div class="metric"><div class="metric-value">No significant changes recorded.</div></div>`;
  }

  return `<table>
    <thead>
      <tr>
        <th>Time</th>
        <th>Kind</th>
        <th>Signal</th>
        <th>Summary</th>
        <th>Selector</th>
      </tr>
    </thead>
    <tbody>
      ${changes
        .slice(0, 20)
        .map((change) => {
          const record = asRecord(change);
          return `<tr>
            <td class="time">${formatTimestamp(numberValue(record?.elapsedMs) ?? 0)}</td>
            <td>${escapeHtml(stringValue(record?.kind) ?? "")}</td>
            <td>${escapeHtml([stringValue(record?.significance), stringValue(record?.group), stringValue(record?.role)].filter(Boolean).join(" / "))}</td>
            <td>${escapeHtml(stringValue(record?.summary) ?? stringValue(record?.text) ?? "")}</td>
            <td class="artifact-path">${escapeHtml(stringValue(record?.selector) ?? "")}</td>
          </tr>`;
        })
        .join("")}
    </tbody>
  </table>`;
}

function parseUiChangeArtifact(
  content: string,
): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(content));
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function renderTimeline(events: TimelineEvent[]): string {
  if (events.length === 0) {
    return `<div class="metric"><div class="metric-value">No timeline events.</div></div>`;
  }

  return `<table>
    <thead>
      <tr>
        <th>Elapsed</th>
        <th>Video</th>
        <th>Type</th>
        <th>Summary</th>
      </tr>
    </thead>
    <tbody>
      ${events
        .map(
          (event) => `<tr>
            <td class="time">${formatTimestamp(event.elapsedMs)}</td>
            <td>${
              event.videoTimeMs === undefined
                ? ""
                : `<button class="seek-inline" data-seek-ms="${event.videoTimeMs}">${formatTimestamp(event.videoTimeMs)}</button>`
            }</td>
            <td>${escapeHtml(event.type)}</td>
            <td>${escapeHtml(event.summary)}</td>
          </tr>`,
        )
        .join("")}
    </tbody>
  </table>`;
}

function renderBookmark(bookmark: DashboardBookmark): string {
  return `<button class="bookmark ${bookmark.tone}" data-seek-ms="${bookmark.timeMs}" data-bookmark-id="${escapeAttr(bookmark.id)}">
    <span class="stamp">${formatTimestamp(bookmark.timeMs)}</span>
    <span>
      <span class="bookmark-title">${escapeHtml(bookmark.label)}</span>
      <span class="bookmark-detail">${escapeHtml(bookmark.detail ?? bookmark.kind)}</span>
    </span>
  </button>`;
}

function renderStatusPill(
  label: string,
  value: string,
  tone: DashboardTone,
  className = "",
): string {
  return `<span class="pill ${tone} ${className}">${escapeHtml(label)}: <strong>${escapeHtml(value)}</strong></span>`;
}

function renderArtifactLink(link: {
  kind: string;
  path: string;
  href: string;
}): string {
  return `<a class="artifact-link" href="${escapeAttr(link.href)}" target="_blank" rel="noreferrer">
    <span class="artifact-kind">${escapeHtml(link.kind)}</span>
    <span class="artifact-path">${escapeHtml(link.path)}</span>
  </a>`;
}

function buildArtifactLinks(result: RunResult, baseDir: string) {
  const baseLinks = [
    { kind: "Dashboard", path: result.artifacts.dashboard },
    { kind: "Run JSON", path: result.artifacts.result },
    { kind: "Markdown Report", path: result.artifacts.report },
    { kind: "Events NDJSON", path: result.artifacts.events },
    ...(result.artifacts.video
      ? [{ kind: "Video", path: result.artifacts.video }]
      : []),
    ...(result.artifacts.videoOriginal
      ? [{ kind: "Original Video", path: result.artifacts.videoOriginal }]
      : []),
    ...(result.artifacts.dataLifecycle?.setup
      ? [
          {
            kind: "Data Lifecycle Setup",
            path: result.artifacts.dataLifecycle.setup,
          },
        ]
      : []),
    ...(result.artifacts.dataLifecycle?.preflight
      ? [
          {
            kind: "Data Lifecycle Preflight",
            path: result.artifacts.dataLifecycle.preflight,
          },
        ]
      : []),
    ...(result.artifacts.dataLifecycle?.postconditions
      ? [
          {
            kind: "Data Lifecycle Postconditions",
            path: result.artifacts.dataLifecycle.postconditions,
          },
        ]
      : []),
    ...(result.artifacts.dataLifecycle?.cleanup
      ? [
          {
            kind: "Data Lifecycle Cleanup",
            path: result.artifacts.dataLifecycle.cleanup,
          },
        ]
      : []),
    ...result.artifacts.screenshots.map((path, index) => ({
      kind: `Screenshot ${index + 1}`,
      path,
    })),
    ...result.artifacts.snapshots.map((path, index) => ({
      kind: `Snapshot ${index + 1}`,
      path,
    })),
    ...(result.artifacts.console ?? []).map((path, index) => ({
      kind: `Console ${index + 1}`,
      path,
    })),
    ...(result.artifacts.network ?? []).map((path, index) => ({
      kind: `Network ${index + 1}`,
      path,
    })),
    ...(result.artifacts.uiChanges ?? []).map((path, index) => ({
      kind: `UI Changes ${index + 1}`,
      path,
    })),
  ];

  return baseLinks.map((link) => {
    const relativePath = toRelativePath(baseDir, link.path);
    return {
      kind: link.kind,
      path: relativePath,
      href: toHref(relativePath),
    };
  });
}

function collectBookmarks(result: RunResult): DashboardBookmark[] {
  const bookmarks =
    result.bookmarks !== undefined
      ? result.bookmarks
      : buildRawActionBookmarks(result.timeline);
  return bookmarks
    .map((bookmark) => ({
      ...bookmark,
      detail: bookmark.detail ?? bookmark.kind,
      tone: bookmarkTone(bookmark),
    }))
    .sort((a, b) => a.timeMs - b.timeMs || a.label.localeCompare(b.label));
}

function collectMomentContexts(
  bookmarks: DashboardBookmark[],
  timeline: TimelineEvent[],
): MomentContext[] {
  const eventById = new Map(timeline.map((event) => [event.id, event]));

  return bookmarks.map((bookmark) => {
    const sourceEvent =
      bookmark.sourceEventIds
        ?.map((id) => eventById.get(id))
        .find((event): event is TimelineEvent => Boolean(event)) ??
      findClosestVideoEvent(bookmark.timeMs, timeline);
    const anchorElapsedMs = sourceEvent?.elapsedMs ?? bookmark.timeMs;
    const nearbyEvents = timeline
      .filter((event) => Math.abs(event.elapsedMs - anchorElapsedMs) <= 8_000)
      .slice(-8)
      .map(({ id, type, summary, elapsedMs, videoTimeMs }) => ({
        id,
        type,
        summary,
        elapsedMs,
        ...(videoTimeMs === undefined ? {} : { videoTimeMs }),
      }));
    const assistantText = extractAssistantText(
      [...timeline]
        .reverse()
        .find(
          (event) =>
            event.type === "agent.message.end" &&
            event.elapsedMs <= anchorElapsedMs,
        ),
    );

    return {
      id: `moment-${bookmark.id}`,
      bookmarkId: bookmark.id,
      label: bookmark.label,
      ...(sourceEvent
        ? {
            event: {
              id: sourceEvent.id,
              type: sourceEvent.type,
              summary: sourceEvent.summary,
              elapsedMs: sourceEvent.elapsedMs,
              ...(sourceEvent.videoTimeMs === undefined
                ? {}
                : { videoTimeMs: sourceEvent.videoTimeMs }),
              ...(sourceEvent.data === undefined
                ? {}
                : { data: stringifyEventData(sourceEvent.data) }),
            },
          }
        : {}),
      ...(assistantText ? { assistantText } : {}),
      nearbyEvents,
    };
  });
}

function collectClickMarkers(timeline: TimelineEvent[]): ClickMarker[] {
  const markers: ClickMarker[] = [];

  for (const event of timeline) {
    if (event.type !== "browser.click" || event.videoTimeMs === undefined) {
      continue;
    }

    const click = readClickData(event.data);
    if (!click) {
      continue;
    }

    markers.push({
      id: `click-${event.id}`,
      eventId: event.id,
      timeMs: event.videoTimeMs,
      x: click.x,
      y: click.y,
      viewportWidth: click.viewportWidth,
      viewportHeight: click.viewportHeight,
      label: event.summary,
    });
  }

  return markers.sort(
    (a, b) => a.timeMs - b.timeMs || a.id.localeCompare(b.id),
  );
}

function renderMomentContext(moment: MomentContext | undefined): string {
  return `<div>
    <div class="panel-title">Moment Context</div>
    <div class="moment-label" data-moment-label>${escapeHtml(moment?.label ?? "No bookmark selected")}</div>
    <div class="moment-meta" data-moment-meta>${
      moment?.event
        ? escapeHtml(
            [
              moment.event.videoTimeMs === undefined
                ? undefined
                : formatTimestamp(moment.event.videoTimeMs),
              moment.event.type,
              moment.event.id,
            ]
              .filter((part): part is string => Boolean(part))
              .join(" · "),
          )
        : ""
    }</div>
    <div class="moment-text" data-moment-text>${escapeHtml(moment?.assistantText ?? "")}</div>
    <div class="moment-events" data-moment-events>${escapeHtml(
      moment
        ? moment.nearbyEvents
            .map(
              (event) =>
                `${formatTimestamp(event.elapsedMs)} ${event.type} ${event.summary}`,
            )
            .join("\n")
        : "",
    )}</div>
  </div>`;
}

function readClickData(data: unknown):
  | {
      x: number;
      y: number;
      viewportWidth: number;
      viewportHeight: number;
    }
  | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }

  const click = (data as Record<string, unknown>).click;
  if (!click || typeof click !== "object") {
    return undefined;
  }

  const record = click as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  const viewportWidth = Number(record.viewportWidth);
  const viewportHeight = Number(record.viewportHeight);
  if (
    ![x, y, viewportWidth, viewportHeight].every(Number.isFinite) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return undefined;
  }

  return { x, y, viewportWidth, viewportHeight };
}

function bookmarkTone(bookmark: VideoBookmark): DashboardTone {
  if (bookmark.kind === "finding") {
    return "fail";
  }
  if (bookmark.kind === "milestone") {
    return "pass";
  }
  return "note";
}

function findClosestVideoEvent(
  timeMs: number,
  timeline: TimelineEvent[],
): TimelineEvent | undefined {
  return timeline
    .filter((event) => event.videoTimeMs !== undefined)
    .sort(
      (a, b) =>
        Math.abs((a.videoTimeMs ?? 0) - timeMs) -
        Math.abs((b.videoTimeMs ?? 0) - timeMs),
    )[0];
}

function extractAssistantText(
  event: TimelineEvent | undefined,
): string | undefined {
  if (!event?.data || typeof event.data !== "object") {
    return undefined;
  }

  const text = (event.data as Record<string, unknown>).text;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

function stringifyEventData(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

function criterionTone(
  result: AgentVerdict["criteria"][number]["result"],
): DashboardTone {
  if (result === "met") {
    return "pass";
  }
  if (result === "blocked") {
    return "block";
  }
  if (result === "not-met") {
    return "fail";
  }
  return "note";
}

function verdictTone(status: AgentVerdict["status"]): DashboardTone {
  if (status === "passed") {
    return "pass";
  }
  if (status === "blocked" || status === "inconclusive") {
    return "block";
  }
  return "fail";
}

function runTone(status: RunResult["runStatus"]): DashboardTone {
  if (status === "completed") {
    return "pass";
  }
  if (status === "cancelled" || status === "blocked") {
    return "block";
  }
  return "fail";
}

function lifecycleTone(
  status: DataLifecycleExecution["status"],
): DashboardTone {
  if (status === "passed" || status === "skipped") {
    return "pass";
  }
  if (status === "blocked") {
    return "block";
  }
  return "fail";
}

function formatEvidence(evidence: EvidenceReference): string {
  return [
    evidence.videoTimeMs === undefined
      ? undefined
      : `video ${formatTimestamp(evidence.videoTimeMs)}`,
    evidence.screenshot ? `screenshot ${evidence.screenshot}` : undefined,
    evidence.snapshot ? `snapshot ${evidence.snapshot}` : undefined,
    evidence.url ? `url ${evidence.url}` : undefined,
    evidence.observation ? evidence.observation : undefined,
    evidence.console ? `console ${evidence.console}` : undefined,
    evidence.network ? `network ${evidence.network}` : undefined,
    evidence.uiChangeTimeline
      ? `uiChangeTimeline ${evidence.uiChangeTimeline}`
      : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" | ");
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${seconds}s`;
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor(ms % 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function toRelativePath(baseDir: string, target: string): string {
  const rel = relative(baseDir, target) || ".";
  return rel.split(sep).join("/");
}

function toHref(path: string): string {
  return path
    .split("/")
    .map((part) =>
      part === "." || part === ".." ? part : encodeURIComponent(part),
    )
    .join("/");
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}
