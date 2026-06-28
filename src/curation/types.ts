import type { RunResult, UserJourney, VideoBookmark } from "../core/schemas.js";

export interface BookmarkCurationContext {
  result: RunResult;
  journey: UserJourney;
}

export interface BookmarkCurator {
  readonly name: string;
  curate(context: BookmarkCurationContext): Promise<VideoBookmark[]>;
}
