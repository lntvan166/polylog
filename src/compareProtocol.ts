import type { Duplicate, Pair, Side } from "./compareModel";
import type { ChangeStatus } from "./types";

export type CompareMode = "files" | "commits";
export interface CRepoRow { repoId: string; name: string; accent: number; status: "differs" | "nobase" | "error"; left: number; right: number; same: number; reason?: string; behind: boolean }
export interface CFile { path: string; oldPath?: string; status?: ChangeStatus; added: number | null; deleted: number | null; both: boolean }
export interface CCommit { sha: string; parent: string | null; subject: string; author: string; time: number; files: number | null }
export type CompareHost =
  | { type: "state"; pair: Pair | null; mode: CompareMode; recent: Pair[]; favorites: string[]; message?: string }
  | { type: "repos"; reading: boolean; summary: string; rows: CRepoRow[]; identical: number; missing: string[]; selected?: string }
  | { type: "detail"; repoId: string; mode: CompareMode; left: CFile[] | CCommit[]; right: CFile[] | CCommit[]; more: { left: boolean; right: boolean }; duplicates: Duplicate[]; error?: string }
  | { type: "commitFiles"; repoId: string; sha: string; files: CFile[]; error?: string }
  | { type: "branches"; names: { name: string; count: number }[] };
export type CompareWebview =
  | { type: "ready" }
  | { type: "pick"; pair: Pair }
  | { type: "swap" }
  | { type: "mode"; mode: CompareMode }
  | { type: "refresh" }
  | { type: "select"; repoId: string }
  | { type: "favorite"; name: string }
  | { type: "wantBranches" }
  | { type: "openFile"; repoId: string; side: Side; path: string }
  | { type: "expand"; repoId: string; sha: string }
  | { type: "openCommitFile"; repoId: string; sha: string; path: string }
  | { type: "more"; repoId: string; side: Side };
