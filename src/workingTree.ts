// Uncommitted changes, read from git: which files differ from the last commit (staged or
// not, and new untracked files), with their +/- counts. Pure: no vscode import.
import type { ChangeStatus, FileChange } from "./types";

/** git's empty tree: what a repository with no commit yet is compared with. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface StatusEntry {
  path: string;
  oldPath?: string;
  /** The change against the last commit. */
  status: ChangeStatus;
  /** Every change is staged: nothing left in the working tree beyond the index. */
  staged: boolean;
  untracked?: boolean;
  conflicted?: boolean;
}

/**
 * Which files differ, ignored ones never; `pathspecs` is the Path filter, after --.
 * --branch adds the last commit's id, so one call per repository says everything.
 */
export function statusArgs(pathspecs: readonly string[]): string[] {
  const args = ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"];
  return pathspecs.length > 0 ? [...args, "--", ...pathspecs] : args;
}

/** +/- counts of the working tree against `head` (null: no commit yet, the empty tree). */
export function numstatArgs(head: string | null, pathspecs: readonly string[]): string[] {
  return ["diff", head ?? EMPTY_TREE, "--numstat", "-z", "-M", "--", ...pathspecs];
}

/** The last commit's id from `git status --branch` ("# branch.oid <sha>"); null before the first commit. */
export function headOf(stdout: string): string | null {
  const m = /(?:^|\0)# branch\.oid ([0-9a-f]{40,64})(?:\0|$)/.exec(stdout);
  return m ? m[1] : null;
}

/** The index (X) and working-tree (Y) letters of one entry, as one change against HEAD. */
function againstHead(x: string, y: string): ChangeStatus | null {
  if (x === "A") return y === "D" ? null : "A"; // added, then deleted again: nothing left
  if (x === "D" || y === "D") return "D";
  if (x === "T" || y === "T") return "T";
  return "M";
}

/** `git status --porcelain=v2 -z` output, one entry per changed file. */
export function parseStatus(stdout: string): StatusEntry[] {
  const out: StatusEntry[] = [];
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "") continue;
    const kind = t[0];
    if (kind === "?") {
      out.push({ path: t.slice(2), status: "A", staged: false, untracked: true });
      continue;
    }
    // Fields are space-separated; the path is everything after the last fixed field.
    const fields = (n: number) => {
      const parts = t.split(" ");
      return { xy: parts[1], path: parts.slice(n).join(" ") };
    };
    if (kind === "1") {
      const { xy, path } = fields(8);
      const status = againstHead(xy[0], xy[1]);
      if (status) out.push({ path, status, staged: xy[1] === "." });
    } else if (kind === "2") {
      const { xy, path } = fields(9);
      const oldPath = tokens[++i]; // the original name is the next NUL field
      const status: ChangeStatus = xy[1] === "D" ? "D" : xy[0] === "C" ? "C" : "R";
      out.push(status === "D" ? { path: oldPath, status, staged: false } : { path, oldPath, status, staged: xy[1] === "." });
    } else if (kind === "u") {
      const { path } = fields(10);
      out.push({ path, status: "M", staged: false, conflicted: true });
    }
  }
  return out;
}

/** `git diff --numstat -z` output: path → counts (null for binary). Renames by the new name. */
export function parseNumstat(stdout: string): Map<string, { added: number | null; deleted: number | null }> {
  const counts = new Map<string, { added: number | null; deleted: number | null }>();
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(tokens[i]);
    if (!m) continue;
    const n = (v: string) => (v === "-" ? null : Number(v));
    let path = m[3];
    if (path === "") {
      i += 2; // rename: "a\td\t", then the old and the new name
      path = tokens[i];
    }
    counts.set(path, { added: n(m[1]), deleted: n(m[2]) });
  }
  return counts;
}

/**
 * The Changes tree's file list for uncommitted work. An untracked file has no count from
 * git diff; it gets 0/0 (not null, which would mean binary), so it opens like any text file.
 */
export function uncommittedFiles(status: readonly StatusEntry[], counts: ReadonlyMap<string, { added: number | null; deleted: number | null }>): FileChange[] {
  return status.map((e) => {
    const c = counts.get(e.path) ?? { added: 0, deleted: 0 };
    return {
      path: e.path,
      ...(e.oldPath ? { oldPath: e.oldPath } : {}),
      added: c.added,
      deleted: c.deleted,
      status: e.status,
      staged: e.staged,
      ...(e.untracked ? { untracked: true } : {}),
    };
  });
}

/** One side of an uncommitted file: what is staged (index) or what is not yet (working tree). */
export interface WorkEntry {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  untracked?: boolean;
  conflicted?: boolean;
}

const letter = (c: string): ChangeStatus => (c === "A" ? "A" : c === "D" ? "D" : c === "T" ? "T" : "M");

/**
 * `git status --porcelain=v2 -z` as Source Control shows it: the index half (Staged) and the
 * working-tree half (Changes). A file staged and changed again is in both.
 */
export function splitStatus(stdout: string): { staged: WorkEntry[]; changes: WorkEntry[] } {
  const staged: WorkEntry[] = [];
  const changes: WorkEntry[] = [];
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "" || t.startsWith("# ")) continue;
    const parts = t.split(" ");
    const kind = t[0];
    if (kind === "?") {
      changes.push({ path: t.slice(2), status: "A", untracked: true });
    } else if (kind === "1") {
      const [x, y] = parts[1];
      const path = parts.slice(8).join(" ");
      if (x !== ".") staged.push({ path, status: letter(x) });
      if (y !== ".") changes.push({ path, status: letter(y) });
    } else if (kind === "2") {
      const [x, y] = parts[1];
      const path = parts.slice(9).join(" ");
      const oldPath = tokens[++i]; // the original name is the next NUL field
      if (x !== ".") staged.push({ path, oldPath, status: x === "C" ? "C" : "R" });
      if (y !== ".") changes.push({ path, status: letter(y) });
    } else if (kind === "u") {
      changes.push({ path: parts.slice(10).join(" "), status: "M", conflicted: true });
    }
  }
  return { staged, changes };
}

/** +/- of what is staged: the index against the last commit (or the empty tree). */
export function stagedNumstatArgs(head: string | null, pathspecs: readonly string[]): string[] {
  return ["diff", "--cached", head ?? EMPTY_TREE, "--numstat", "-z", "-M", "--", ...pathspecs];
}

/** +/- of what is not staged: the working tree against the index. */
export function unstagedNumstatArgs(pathspecs: readonly string[]): string[] {
  return ["diff", "--numstat", "-z", "--", ...pathspecs];
}

/** One side's file list, with its counts. Untracked files count 0/0 (new, not binary). */
export function workFiles(entries: readonly WorkEntry[], counts: ReadonlyMap<string, { added: number | null; deleted: number | null }>): FileChange[] {
  return entries.map((e) => {
    const c = counts.get(e.path) ?? { added: 0, deleted: 0 };
    return { path: e.path, ...(e.oldPath ? { oldPath: e.oldPath } : {}), added: c.added, deleted: c.deleted, status: e.status, ...(e.untracked ? { untracked: true } : {}) };
  });
}
