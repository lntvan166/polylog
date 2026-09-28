import * as vscode from "vscode";
import { decorationFor, describeChanges, type ChangesState, type NodeDesc, type Owner } from "./changesModel";

export interface OpenDiffArgs {
  repoId: string;
  sha: string;
  parent: string | null;
  path: string;
  oldPath?: string;
  /** The file's status in the commit (A, D, …): its empty side needs no git process. */
  status?: string;
}

export interface ChangesSnapshot {
  message: string | undefined;
  items: string[];
  /** URI scheme of every node's resourceUri, as VS Code receives it (test seam). */
  schemes: string[];
  /** "<file> <badge> <theme color>" for every decorated file (test seam). */
  decorations: string[];
  /** File history: the highlighted file's label. */
  focused: string | undefined;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const TREE_SCHEME = "polylog-tree";

/** The native Changes view: a thin adapter from changesModel's descriptors to TreeItems. */
export class ChangesTree implements vscode.TreeDataProvider<NodeDesc>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<NodeDesc | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  /** uri.toString() → decoration, for the files of the commit on screen. */
  private decorations = new Map<string, vscode.FileDecoration>();
  /** The URIs decorated now: a new commit tells VS Code about these and the new ones only. */
  private decorated: vscode.Uri[] = [];
  private readonly view: vscode.TreeView<NodeDesc>;
  private state: ChangesState | null = null;
  private roots: NodeDesc[] = [];
  private message: string | undefined;
  private parents = new Map<NodeDesc, NodeDesc>();
  private focused: NodeDesc | undefined;

  constructor() {
    this.view = vscode.window.createTreeView("polylog.changes", { treeDataProvider: this, showCollapseAll: true });
    this.render();
  }

  /** Expanded and on screen (keepExpanded.ts). */
  get visible(): boolean {
    return this.view.visible;
  }

  get onDidChangeVisibility(): vscode.Event<vscode.TreeViewVisibilityChangeEvent> {
    return this.view.onDidChangeVisibility;
  }

  /** Revealing needs a node: with no commit selected there is nothing to reveal quietly. */
  get canExpand(): boolean {
    return this.roots.length > 0;
  }

  /** Expand the view again without taking focus or changing the selection. */
  expand(): void {
    const root = this.roots[0];
    if (root) void this.view.reveal(root, { select: false, focus: false }).then(undefined, () => undefined);
  }

  set(state: ChangesState | null): void {
    this.state = state;
    this.render();
  }

  current(): ChangesState | null {
    return this.state;
  }

  snapshot(): ChangesSnapshot {
    const walk = (nodes: NodeDesc[], depth: number): string[] =>
      nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.label} | ${n.description}`, ...(n.kind === "file" ? [] : walk(n.children, depth + 1))]);
    const all = (nodes: NodeDesc[]): NodeDesc[] => nodes.flatMap((n) => [n, ...(n.kind === "file" ? [] : all(n.children))]);
    const schemes = all(this.roots).flatMap((n) => {
      const uri = this.getTreeItem(n).resourceUri;
      return uri ? [uri.scheme] : [];
    });
    const decorations = all(this.roots).flatMap((n) => {
      const uri = this.getTreeItem(n).resourceUri;
      const d = uri && this.provideFileDecoration(uri);
      const model = n.kind === "file" ? decorationFor(n.file.status) : undefined;
      return d && model ? [`${n.label} ${d.badge} ${model.color}`] : [];
    });
    return { message: this.message, items: walk(this.roots, 0), schemes, decorations, focused: this.focused?.label };
  }

  private render(): void {
    const d = describeChanges(this.state, nowSec());
    this.roots = d.roots;
    this.message = d.message;
    this.view.message = d.message;
    this.decorations = new Map();
    const before = this.decorated;
    this.decorated = [];
    const files = (nodes: NodeDesc[]): void => nodes.forEach((n) => {
      if (n.kind !== "file") return files(n.children);
      const dec = decorationFor(n.file.status);
      if (!dec) return;
      const uri = this.uriFor(n.path, n.owner);
      this.decorations.set(uri.toString(), new vscode.FileDecoration(dec.badge, dec.tooltip, new vscode.ThemeColor(dec.color)));
      this.decorated.push(uri);
    });
    files(this.roots);
    this.parents = new Map();
    this.focused = undefined;
    const index = (nodes: NodeDesc[], parent?: NodeDesc): void => nodes.forEach((n) => {
      if (parent) this.parents.set(n, parent);
      if (n.kind === "file" && n.path === this.state?.focusPath) this.focused = n;
      if (n.kind !== "file") index(n.children, n);
    });
    index(this.roots);
    this.emitter.fire(undefined);
    const changed = [...before, ...this.decorated];
    if (changed.length > 0) this.decorationsChanged.fire(changed);
    // File history: select the file this history is about, without taking focus from the Log.
    const target = this.focused;
    if (target && this.view.visible) setTimeout(() => void this.view.reveal(target, { select: true, focus: false }).then(undefined, () => undefined), 0);
  }

  /**
   * Scheme keeps live worktree decorations off; the commit in the query keeps
   * one commit's colors from ever landing on another commit's same path.
   */
  private uriFor(path: string, owner?: Owner): vscode.Uri {
    // The repository too: in Review Uncommitted, the same path can appear in several repos.
    const query = owner ? `${owner.sha}:${owner.repoId}` : this.state?.commit.sha ?? "";
    return vscode.Uri.from({ scheme: TREE_SCHEME, path: `/${path}`, query });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return uri.scheme === TREE_SCHEME ? this.decorations.get(uri.toString()) : undefined;
  }

  getParent(node: NodeDesc): NodeDesc | undefined {
    return this.parents.get(node);
  }

  getChildren(node?: NodeDesc): NodeDesc[] {
    if (!node) return this.roots;
    return node.kind === "file" ? [] : node.children;
  }

  getTreeItem(node: NodeDesc): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.kind === "file" ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded);
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip;
    if (node.kind === "commit") {
      item.iconPath = new vscode.ThemeIcon("git-commit");
      item.contextValue = "commit";
      return item;
    }
    // resourceUri lets the file-icon theme pick icons from the name. A private
    // scheme, not the worktree file: URI, so live git and Problems decorations
    // for today's files are not painted onto a historical commit.
    item.resourceUri = this.uriFor(node.path, node.kind === "file" ? node.owner : undefined);
    item.iconPath = node.kind === "folder" ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    // A deleted file has no working-tree copy to open: "fileDeleted" drops Open File from its menu.
    if (node.kind === "file") item.contextValue = node.file.status === "D" ? "fileDeleted" : "file";
    if (node.kind === "file" && node.openable) {
      const args: OpenDiffArgs = { repoId: node.owner.repoId, sha: node.owner.sha, parent: node.owner.parent, path: node.file.path, oldPath: node.file.oldPath, status: node.file.status };
      item.command = { command: "polylog.openDiff", title: "Open Diff", arguments: [args] };
    }
    return item;
  }

  dispose(): void {
    this.view.dispose();
    this.emitter.dispose();
    this.decorationsChanged.dispose();
  }
}
