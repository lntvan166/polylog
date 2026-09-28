import { fileTree, type TreeNode } from "./fileTree";
import { commitKey, UNCOMMITTED, type ChangeStatus, type Commit, type FileChange } from "./types";
import { absoluteTime, relativeTime } from "./webview/view";

export type ChangesStatus = "loading" | "ready" | "error";

export interface ChangesState {
  commit: Commit;
  repoRoot: string;
  repoName: string;
  status: ChangesStatus;
  files: FileChange[];
  /** Full commit message; "" until loaded. */
  message: string;
  error?: string;
  /** File history: the file to highlight in the tree. */
  focusPath?: string;
  /** Review Uncommitted: every repository's uncommitted files, one group each (commit/files unused). */
  groups?: ChangesGroup[];
}

export interface ChangesGroup {
  commit: Commit;
  repoRoot: string;
  repoName: string;
  files: FileChange[];
}

/** Which repository and revision a file node belongs to, for opening its diff. */
export interface Owner {
  repoId: string;
  sha: string;
  parent: string | null;
}

interface Base {
  /** Stable across re-renders so VS Code keeps each folder's expand state. */
  id: string;
  label: string;
  description: string;
  tooltip: string;
}
export interface CommitDesc extends Base { kind: "commit"; children: NodeDesc[] }
export interface FolderDesc extends Base { kind: "folder"; path: string; children: NodeDesc[] }
export interface FileDesc extends Base { kind: "file"; path: string; file: FileChange; openable: boolean; owner: Owner }
export type NodeDesc = CommitDesc | FolderDesc | FileDesc;

export interface Decoration {
  badge: string;
  /** A theme color id, so the tree uses the user's own git colors. */
  color: string;
  tooltip: string;
}

const DECORATIONS: Record<ChangeStatus, Decoration> = {
  A: { badge: "A", color: "gitDecoration.addedResourceForeground", tooltip: "Added" },
  M: { badge: "M", color: "gitDecoration.modifiedResourceForeground", tooltip: "Modified" },
  D: { badge: "D", color: "gitDecoration.deletedResourceForeground", tooltip: "Deleted" },
  R: { badge: "R", color: "gitDecoration.renamedResourceForeground", tooltip: "Renamed" },
  C: { badge: "C", color: "gitDecoration.addedResourceForeground", tooltip: "Copied" },
  T: { badge: "T", color: "gitDecoration.modifiedResourceForeground", tooltip: "Type changed" },
};

/** What the commit did to a file, as a native file decoration (color + badge). */
export function decorationFor(status: ChangeStatus | undefined): Decoration | undefined {
  return status ? DECORATIONS[status] : undefined;
}

export const NO_SELECTION = "Select a commit in the Log to see its changed files.";
export const LOADING = "Loading changed files…";
export const NO_FILES = "This commit changes no files.";
export const NO_UNCOMMITTED = "No uncommitted changes.";

export function firstOpenable(files: readonly FileChange[]): FileChange | undefined {
  return files.find((f) => f.added !== null);
}

function stat(f: FileChange): string {
  if (f.untracked) return "new";
  if (f.added === null) return f.staged ? "binary · staged" : "binary";
  const counts = `+${f.added} −${f.deleted}`;
  const shown = f.oldPath ? `← ${f.oldPath}  ${counts}` : counts;
  return f.staged ? `${shown} · staged` : shown;
}

function describeNodes(nodes: readonly TreeNode[], parent: string, base: string, owner: Owner): NodeDesc[] {
  return nodes.map((n): NodeDesc => {
    if (n.kind === "folder") {
      const path = parent ? `${parent}/${n.name}` : n.name;
      return { kind: "folder", id: `${base}/d:${path}`, label: n.name, description: String(n.count), tooltip: path, path, children: describeNodes(n.children, path, base, owner) };
    }
    const f = n.file;
    return {
      kind: "file", id: `${base}/f:${f.path}`, label: n.name, description: stat(f),
      tooltip: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path, path: f.path, file: f, openable: f.added !== null, owner,
    };
  });
}

/** Everything the Changes tree shows, as plain data. The VS Code adapter only maps it to TreeItems. */
export function describeChanges(s: ChangesState | null, now: number): { message: string | undefined; roots: NodeDesc[] } {
  if (!s) return { message: NO_SELECTION, roots: [] };
  const c = s.commit;
  const base = commitKey(c);
  const tooltip = `${s.message || c.subject}\n\n${c.author} <${c.email}> · ${absoluteTime(c.time)} · ${s.repoName}\n${c.sha}`;
  if (s.groups) {
    const roots = s.groups.filter((g) => g.files.length > 0).map((g): CommitDesc => {
      const key = commitKey(g.commit);
      const n = g.files.length;
      const owner = { repoId: g.commit.repoId, sha: g.commit.sha, parent: g.commit.parents[0] ?? null };
      return {
        kind: "commit", id: key, label: g.repoName, description: `${n} ${n === 1 ? "file" : "files"} · not committed`,
        tooltip: `${g.repoName}: changes since the last commit, staged or not`, children: describeNodes(fileTree(g.files), "", key, owner),
      };
    });
    return { message: roots.length === 0 ? NO_UNCOMMITTED : undefined, roots };
  }
  const owner = { repoId: c.repoId, sha: c.sha, parent: c.parents[0] ?? null };
  const children = s.status === "ready" ? describeNodes(fileTree(s.files), "", base, owner) : [];
  const pending = c.sha === UNCOMMITTED;
  const n = s.files.length;
  const description = pending ? `${n} ${n === 1 ? "file" : "files"} · not committed` : `${c.sha.slice(0, 7)} · ${c.author} · ${relativeTime(now, c.time)}`;
  const root: CommitDesc = { kind: "commit", id: base, label: c.subject, description, tooltip: pending ? `${s.repoName}: changes since the last commit, staged or not` : tooltip, children };
  const message =
    s.status === "loading" ? LOADING
    : s.status === "error" ? `Could not read this commit: ${s.error ?? "unknown error"}`
    : s.files.length === 0 ? NO_FILES
    : undefined;
  return { message, roots: [root] };
}
