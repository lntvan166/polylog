import { fileTree, type TreeNode } from "./fileTree";
import { commitKey, type Commit, type FileChange } from "./types";
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
export interface FileDesc extends Base { kind: "file"; path: string; file: FileChange; openable: boolean }
export type NodeDesc = CommitDesc | FolderDesc | FileDesc;

export const NO_SELECTION = "Select a commit in the Log to see its changed files.";
export const LOADING = "Loading changed files…";
export const NO_FILES = "This commit changes no files.";

export function firstOpenable(files: readonly FileChange[]): FileChange | undefined {
  return files.find((f) => f.added !== null);
}

function stat(f: FileChange): string {
  if (f.added === null) return "binary";
  const counts = `+${f.added} −${f.deleted}`;
  return f.oldPath ? `← ${f.oldPath}  ${counts}` : counts;
}

function describeNodes(nodes: readonly TreeNode[], parent: string, base: string): NodeDesc[] {
  return nodes.map((n): NodeDesc => {
    if (n.kind === "folder") {
      const path = parent ? `${parent}/${n.name}` : n.name;
      return { kind: "folder", id: `${base}/d:${path}`, label: n.name, description: String(n.count), tooltip: path, path, children: describeNodes(n.children, path, base) };
    }
    const f = n.file;
    return {
      kind: "file", id: `${base}/f:${f.path}`, label: n.name, description: stat(f),
      tooltip: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path, path: f.path, file: f, openable: f.added !== null,
    };
  });
}

/** Everything the Changes tree shows, as plain data. The VS Code adapter only maps it to TreeItems. */
export function describeChanges(s: ChangesState | null, now: number): { message: string | undefined; roots: NodeDesc[] } {
  if (!s) return { message: NO_SELECTION, roots: [] };
  const c = s.commit;
  const base = commitKey(c);
  const tooltip = `${s.message || c.subject}\n\n${c.author} <${c.email}> · ${absoluteTime(c.time)} · ${s.repoName}\n${c.sha}`;
  const children = s.status === "ready" ? describeNodes(fileTree(s.files), "", base) : [];
  const root: CommitDesc = { kind: "commit", id: base, label: c.subject, description: `${c.sha.slice(0, 7)} · ${c.author} · ${relativeTime(now, c.time)}`, tooltip, children };
  const message =
    s.status === "loading" ? LOADING
    : s.status === "error" ? `Could not read this commit: ${s.error ?? "unknown error"}`
    : s.files.length === 0 ? NO_FILES
    : undefined;
  return { message, roots: [root] };
}
