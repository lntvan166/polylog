import * as path from "path";
import * as vscode from "vscode";
import { describeChanges, type ChangesState, type NodeDesc } from "./changesModel";

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
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** The native Changes view: a thin adapter from changesModel's descriptors to TreeItems. */
export class ChangesTree implements vscode.TreeDataProvider<NodeDesc>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<NodeDesc | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
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
    return { message: this.message, items: walk(this.roots, 0) };
  }

  private render(): void {
    const d = describeChanges(this.state, nowSec());
    this.roots = d.roots;
    this.message = d.message;
    this.view.message = d.message;
    this.emitter.fire(undefined);
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
    // resourceUri lets the user's file-icon theme pick folder and file icons.
    item.resourceUri = vscode.Uri.file(path.join(s.repoRoot, node.path));
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
  }
}
