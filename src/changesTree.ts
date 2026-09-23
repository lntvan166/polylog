import * as vscode from "vscode";
import { decorationFor, describeChanges, type ChangesState, type NodeDesc } from "./changesModel";

export interface OpenDiffArgs {
  repoId: string;
  sha: string;
  parent: string | null;
  path: string;
  oldPath?: string;
}

export interface ChangesSnapshot {
  message: string | undefined;
  items: string[];
  /** URI scheme of every node's resourceUri, as VS Code receives it (test seam). */
  schemes: string[];
  /** "<file> <badge> <theme color>" for every decorated file (test seam). */
  decorations: string[];
}

const nowSec = () => Math.floor(Date.now() / 1000);
const TREE_SCHEME = "polylog-tree";

/** The native Changes view: a thin adapter from changesModel's descriptors to TreeItems. */
export class ChangesTree implements vscode.TreeDataProvider<NodeDesc>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<NodeDesc | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly decorationsChanged = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  /** uri.toString() → decoration, for the files of the commit on screen. */
  private decorations = new Map<string, vscode.FileDecoration>();
  private readonly view: vscode.TreeView<NodeDesc>;
  private state: ChangesState | null = null;
  private roots: NodeDesc[] = [];
  private message: string | undefined;

  constructor() {
    this.view = vscode.window.createTreeView("polylog.changes", { treeDataProvider: this, showCollapseAll: true });
    this.render();
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
    return { message: this.message, items: walk(this.roots, 0), schemes, decorations };
  }

  private render(): void {
    const d = describeChanges(this.state, nowSec());
    this.roots = d.roots;
    this.message = d.message;
    this.view.message = d.message;
    this.decorations = new Map();
    const files = (nodes: NodeDesc[]): void => nodes.forEach((n) => {
      if (n.kind !== "file") return files(n.children);
      const dec = decorationFor(n.file.status);
      if (dec) this.decorations.set(this.uriFor(n.path).toString(), new vscode.FileDecoration(dec.badge, dec.tooltip, new vscode.ThemeColor(dec.color)));
    });
    files(this.roots);
    this.emitter.fire(undefined);
    this.decorationsChanged.fire(undefined);
  }

  /**
   * Scheme keeps live worktree decorations off; the commit in the query keeps
   * one commit's colors from ever landing on another commit's same path.
   */
  private uriFor(path: string): vscode.Uri {
    return vscode.Uri.from({ scheme: TREE_SCHEME, path: `/${path}`, query: this.state?.commit.sha ?? "" });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return uri.scheme === TREE_SCHEME ? this.decorations.get(uri.toString()) : undefined;
  }

  getChildren(node?: NodeDesc): NodeDesc[] {
    if (!node) return this.roots;
    return node.kind === "file" ? [] : node.children;
  }

  getTreeItem(node: NodeDesc): vscode.TreeItem {
    const s = this.state!;
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
    item.resourceUri = this.uriFor(node.path);
    item.iconPath = node.kind === "folder" ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;
    if (node.kind === "file" && node.openable) {
      const args: OpenDiffArgs = { repoId: s.commit.repoId, sha: s.commit.sha, parent: s.commit.parents[0] ?? null, path: node.file.path, oldPath: node.file.oldPath };
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
