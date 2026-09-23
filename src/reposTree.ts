import * as vscode from "vscode";
import { ALL_REPOS, repoColor, repoIdsFromSelection, selectionFromRepoIds } from "./repoSelection";
import type { Repo } from "./types";

/** globalState key: true when the user turned Group by Repository off. */
export const HIDE_REPOS_KEY = "polylog.hideRepos";
const SCHEME = "polylog-repo";

interface RepoNode {
  id: string;
  label: string;
  repo?: Repo;
}

export interface RepoTreeSnapshot {
  items: string[];
  selected: string[];
}

/**
 * The Repositories view: pick one or more repos to filter the Log to them.
 * It shares the Log's repo filter, so it and the Log's dropdown always agree.
 */
export class ReposTree implements vscode.TreeDataProvider<RepoNode>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<RepoNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly decorationsChanged = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  private readonly view: vscode.TreeView<RepoNode>;
  private readonly disposables: vscode.Disposable[] = [];
  private nodes: RepoNode[] = [];
  private repoIds: string[] | null = null;
  private selectedIds: string[] = [ALL_REPOS];
  /** Set by the Log: the user picked repos here. */
  onPick: ((repoIds: string[] | null) => void) | undefined;

  constructor() {
    this.view = vscode.window.createTreeView("polylog.repos", { treeDataProvider: this, canSelectMany: true });
    this.disposables.push(this.view.onDidChangeSelection((e) => this.pick(e.selection.map((n) => n.id))));
  }

  /** A user (or test) selection. Re-applying the current filter is a no-op in the Log, so echoes cannot loop. */
  pick(ids: readonly string[]): void {
    this.selectedIds = ids.length > 0 ? [...ids] : [ALL_REPOS];
    this.onPick?.(repoIdsFromSelection(ids));
  }

  setRepos(repos: readonly Repo[], repoIds: string[] | null): void {
    this.nodes = [{ id: ALL_REPOS, label: "All repositories" }, ...repos.map((r) => ({ id: r.id, label: r.name, repo: r }))];
    this.emitter.fire(undefined);
    void this.select(repoIds);
  }

  /** Mirror the Log's repo filter (e.g. changed from its dropdown). */
  async select(repoIds: string[] | null): Promise<void> {
    this.repoIds = repoIds;
    this.selectedIds = selectionFromRepoIds(repoIds, this.repoNodeIds());
    this.decorationsChanged.fire(undefined);
    const first = this.nodes.find((n) => n.id === this.selectedIds[0]);
    const current = this.view.selection.map((n) => n.id).join("\0");
    if (!first || !this.view.visible || current === this.selectedIds.join("\0")) return;
    try {
      await this.view.reveal(first, { select: true, focus: false });
    } catch {
      // The view is closing or not rendered yet; the next setRepos/select catches up.
    }
  }

  snapshot(): RepoTreeSnapshot {
    const label = (id: string) => this.nodes.find((n) => n.id === id)?.label ?? id;
    return { items: this.nodes.map((n) => n.label), selected: this.selectedIds.map(label) };
  }

  private repoNodeIds(): string[] {
    return this.nodes.filter((n) => n.repo).map((n) => n.id);
  }

  getChildren(node?: RepoNode): RepoNode[] {
    return node ? [] : this.nodes;
  }

  getParent(): undefined {
    return undefined;
  }

  getTreeItem(node: RepoNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.id = node.id;
    if (!node.repo) {
      item.iconPath = new vscode.ThemeIcon("layers");
      item.tooltip = "Show commits from every repository";
      return item;
    }
    item.iconPath = new vscode.ThemeIcon("repo");
    item.tooltip = node.repo.root;
    // Only for the name color below; a private scheme, so nothing else decorates it.
    item.resourceUri = vscode.Uri.from({ scheme: SCHEME, path: `/${node.label}`, query: encodeURIComponent(node.id) });
    return item;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== SCHEME) return undefined;
    const id = decodeURIComponent(uri.query);
    return new vscode.FileDecoration(undefined, undefined, new vscode.ThemeColor(repoColor(id, this.repoIds, this.repoNodeIds())));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.view.dispose();
    this.emitter.dispose();
    this.decorationsChanged.dispose();
  }
}
