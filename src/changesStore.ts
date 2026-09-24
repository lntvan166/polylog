// The commit shown in the Changes pane, drawn by the Log webview (panel spec §15). The
// host owns it; the webview gets a plain description. Pure: no vscode import.
import { decorationFor, describeChanges, type ChangesState, type NodeDesc } from "./changesModel";
import type { ChangesView, OpenDiffArgs } from "./protocol";

export interface ChangesSnapshot {
  message: string | undefined;
  items: string[];
  /** "<file> <badge> <theme color>" for every file with a status (test seam). */
  decorations: string[];
  /** File history: the highlighted file's label. */
  focused: string | undefined;
}

const nowSec = () => Math.floor(Date.now() / 1000);

export class ChangesStore {
  private state: ChangesState | null = null;
  private readonly listeners = new Set<() => void>();

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  set(state: ChangesState | null): void {
    this.state = state;
    for (const l of this.listeners) l();
  }

  current(): ChangesState | null {
    return this.state;
  }

  view(now = nowSec()): ChangesView {
    const d = describeChanges(this.state, now);
    const full = this.state?.message ?? "";
    const body = full.split("\n").slice(1).join("\n").trim();
    return { message: d.message, roots: d.roots, focusPath: this.state?.focusPath, body };
  }

  /** The diff for one of this commit's files, if the webview's path really is one. */
  openable(path: unknown): OpenDiffArgs | undefined {
    const s = this.state;
    if (!s || s.status !== "ready" || typeof path !== "string") return undefined;
    const f = s.files.find((x) => x.path === path);
    if (!f || f.added === null) return undefined;
    return { repoId: s.commit.repoId, sha: s.commit.sha, parent: s.commit.parents[0] ?? null, path: f.path, oldPath: f.oldPath };
  }

  snapshot(): ChangesSnapshot {
    const { message, roots } = this.view();
    const walk = (nodes: NodeDesc[], depth: number): string[] =>
      nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.label} | ${n.description}`, ...(n.kind === "file" ? [] : walk(n.children, depth + 1))]);
    const files = (nodes: NodeDesc[]): Extract<NodeDesc, { kind: "file" }>[] => nodes.flatMap((n) => (n.kind === "file" ? [n] : files(n.children)));
    const all = files(roots);
    const decorations = all.flatMap((n) => {
      const d = decorationFor(n.file.status);
      return d ? [`${n.label} ${d.badge} ${d.color}`] : [];
    });
    const focused = all.find((n) => n.path === this.state?.focusPath)?.label;
    return { message, items: walk(roots, 0), decorations, focused };
  }
}
