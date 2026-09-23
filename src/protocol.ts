import type { FilterState } from "./filterModel";
import type { Commit, Repo, RepoFailure } from "./types";

/** The Log view's own layout: the Repositories pane's width and whether it is shown. */
export interface Layout {
  repoPaneWidth: number;
  groupByRepo: boolean;
}

/** Extension host → webview. */
export type HostMessage =
  | { type: "init"; repos: Repo[]; filter: FilterState; me?: string; layout: Layout }
  | { type: "loading" }
  | { type: "page"; rows: Commit[]; append: boolean; failures: RepoFailure[]; done: boolean; now: number };

/** Webview → extension host. Every field is untrusted until validated. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "filter"; filter: FilterState }
  | { type: "loadMore" }
  | { type: "refresh" }
  | { type: "select"; repoId: string; sha: string }
  | { type: "openFirst"; repoId: string; sha: string }
  | { type: "layout"; repoPaneWidth: number }
  | { type: "openSettings" };
