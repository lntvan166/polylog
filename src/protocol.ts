import type { FilterState } from "./filterModel";
import type { BranchUse } from "./logQuery";
import type { Commit, Repo, RepoFailure } from "./types";

/** The Log view's own layout: the Repositories pane's width and whether it is shown. */
export interface Layout {
  repoPaneWidth: number;
  groupByRepo: boolean;
}

/** Someone who committed recently, across the workspace (Author box suggestions). */
export interface AuthorName {
  name: string;
  email: string;
  count: number;
}

/** A branch name seen across the workspace, with how many repositories have it. */
export interface BranchName {
  name: string;
  count: number;
}

/** Extension host → webview. */
export type HostMessage =
  | { type: "init"; repos: Repo[]; filter: FilterState; hasMe: boolean; layout: Layout; history: { repoName: string; path: string } | null; branches: BranchName[]; authors: AuthorName[] }
  | { type: "loading" }
  | { type: "page"; rows: Commit[]; append: boolean; failures: RepoFailure[]; done: boolean; now: number; branchUse?: BranchUse };

/** Webview → extension host. Every field is untrusted until validated. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "filter"; filter: FilterState }
  | { type: "loadMore" }
  | { type: "refresh" }
  | { type: "select"; repoId: string; sha: string }
  | { type: "openFirst"; repoId: string; sha: string }
  | { type: "layout"; repoPaneWidth: number }
  | { type: "exitHistory" }
  | { type: "openSettings" };
