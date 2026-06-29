---
type: Product Overview
title: JourneyTest Overview
description: Defines JourneyTest's purpose, ownership boundaries, and non-goals.
tags:
  - journeytest
  - product
  - overview
timestamp: 2026-06-29T10:33:26Z
source_files:
  - README.md
  - IMPLEMENTATION_PLAN.md
  - src/runner/runJourney.ts
---

# JourneyTest Overview

JourneyTest is a TypeScript library and CLI for AI-agent-directed user journey
testing of web applications. It standardizes tester profiles, authored journeys,
explicit pass/fail/blocker criteria, browser evidence, agent-owned verdicts, and
reviewable run artifacts.

The framework owns deterministic orchestration:

- validating tester profiles and journey JSON;
- enforcing allowed origins before navigation;
- starting and closing browser drivers;
- recording event timelines and evidence artifacts;
- validating the agent's structured verdict;
- writing JSON, Markdown, dashboard, video, screenshot, snapshot, console,
  network, and UI-change artifacts.

The agent owns the verdict. A journey tells the agent what user perspective to
take, what tasks to complete, and which criteria define pass, fail, or blocker
outcomes. The director must return a structured verdict, and JourneyTest checks
that verdict against the journey schema before persisting it.

The first built-in director is `pi`, implemented with
`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`. The first built-in
browser driver is `agent-browser`, which shells out to the installed
`agent-browser` CLI.

JourneyTest is not a hosted SaaS runner, automatic crawler, or independent
deterministic pass/fail judge. It provides the repeatable rails around an agent
that performs the journey and explains the outcome.
