export interface Repo {
  /** Absolute repository root; stable identity across messages. */
  id: string;
  /** Display label; unique within one workspace (see repos.ts). */
  name: string;
  root: string;
}

export interface Commit {
  repoId: string;
  sha: string;
  /** Committer date, unix seconds — the only sort key unrelated repos share. */
  time: number;
  author: string;
  email: string;
  subject: string;
  parents: string[];
  /** File history only: the file as it was in this commit (it may have been renamed since). */
  file?: { path: string; oldPath?: string; status?: ChangeStatus };
}

/** What a commit did to a file, from `git show --raw`: Added, Modified, Deleted, Renamed, Copied, Type-changed. */
export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T";

export interface FileChange {
  path: string;
  /** Set for renames. */
  oldPath?: string;
  /** null for binary files. */
  added: number | null;
  deleted: number | null;
  status?: ChangeStatus;
}

export interface RepoFailure {
  repoId: string;
  name: string;
  reason: string;
}

export function commitKey(c: { repoId: string; sha: string }): string {
  return `${c.repoId}\0${c.sha}`;
}

/** 40-hex (SHA-1) or 64-hex (SHA-256) object name. Guards every ref that crosses the webview boundary. */
export function isSha(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(s);
}
