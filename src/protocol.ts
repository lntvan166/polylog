import type { FilterState } from "./filterModel";
import type { Commit, FileChange, Repo, RepoFailure } from "./types";

/** Extension host → webview. */
export type HostMessage =
  | { type: "init"; repos: Repo[]; filter: FilterState }
  | { type: "loading" }
  | { type: "page"; rows: Commit[]; append: boolean; failures: RepoFailure[]; done: boolean; now: number }
  | { type: "detail"; repoId: string; sha: string; files: FileChange[] | null; message?: string; error?: string };

/** Webview → extension host. Every field is untrusted until validated. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "filter"; filter: FilterState }
  | { type: "loadMore" }
  | { type: "refresh" }
  | { type: "select"; repoId: string; sha: string }
  | { type: "openFile"; repoId: string; sha: string; parent: string | null; path: string; oldPath?: string }
  | { type: "openSettings" };
