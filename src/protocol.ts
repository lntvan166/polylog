import type { NodeDesc } from "./changesModel";
import type { FilterState } from "./filterModel";
import type { BranchUse } from "./logQuery";
import type { Commit, Repo, RepoFailure } from "./types";

/** The Log view's own layout: the side panes' widths and whether Repositories is shown. */
export interface Layout {
  repoPaneWidth: number;
  changesPaneWidth: number;
  groupByRepo: boolean;
}

/** One file's diff: what the host needs to open it in the editor area. */
export interface OpenDiffArgs {
  repoId: string;
  sha: string;
  parent: string | null;
  path: string;
  oldPath?: string;
}

/** The Changes pane (panel spec §15): the host's description of the selected commit. */
export interface ChangesView {
  /** A status line instead of (or with) the tree: loading, error, no selection, no files. */
  message: string | undefined;
  roots: NodeDesc[];
  /** File history: the file to select in the tree. */
  focusPath: string | undefined;
  /** The commit message below its subject line; "" when there is none. */
  body: string;
}

/** A branch name seen across the workspace, with how many repositories have it. */
export interface BranchName {
  name: string;
  count: number;
}

/** Extension host → webview. */
export type HostMessage =
  | { type: "init"; repos: Repo[]; filter: FilterState; hasMe: boolean; layout: Layout; history: { repoName: string; path: string } | null; branches: BranchName[] }
  | { type: "loading" }
  | { type: "page"; rows: Commit[]; append: boolean; failures: RepoFailure[]; done: boolean; now: number; branchUse?: BranchUse }
  | { type: "changes"; view: ChangesView };

/** Webview → extension host. Every field is untrusted until validated. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "filter"; filter: FilterState }
  | { type: "loadMore" }
  | { type: "refresh" }
  | { type: "select"; repoId: string; sha: string }
  | { type: "openFirst"; repoId: string; sha: string }
  | { type: "openFile"; path: string }
  | { type: "layout"; repoPaneWidth?: number; changesPaneWidth?: number }
  | { type: "exitHistory" }
  | { type: "openSettings" };
