import * as path from "path";
import * as vscode from "vscode";
import { decorationFor, stat } from "./changesModel";
import { COMMIT_PAGE, pairDuplicates, pickerGroups, pushRecent, repoDescription, summaryLabel, tabTitle, validPair, type Pair, type PickerItem, type RepoCompare, type Side, type SideCommit } from "./compareModel";
import type { CompareStore } from "./compareStore";
import type { OpenDiffArgs } from "./changesTree";
import { fileTree, type TreeNode } from "./fileTree";
import type { LogView } from "./logView";
import { isAbortError } from "./pool";
import type { FileChange } from "./types";

const PAIR = "polylog.compare.pair";
const RECENT = "polylog.compare.recent";
const FAVORITES = "polylog.compare.favorites";
const MODE = "polylog.compare.mode";
const SCHEME = "polylog-compare";

export type CompareMode = "files" | "commits";

/** One row of the Compare view. */
type CNode =
  | { kind: "repo"; id: string; repoId: string }
  | { kind: "side"; id: string; repoId: string; side: Side }
  | { kind: "both"; id: string; repoId: string }
  | { kind: "folder"; id: string; repoId: string; name: string; path: string; count: number; children: CNode[] }
  | { kind: "file"; id: string; repoId: string; side: Side; name: string; file: FileChange; both: boolean; commit?: { sha: string; parent: string | null } }
  | { kind: "commit"; id: string; repoId: string; side: Side; commit: SideCommit }
  | { kind: "dup"; id: string; label: string; description: string }
  | { kind: "missing"; id: string }
  | { kind: "name"; id: string; label: string };

/** A repository's detail as read for one result: dropped when its branches move. */
interface Detail {
  key: string;
  files?: { left: FileChange[]; right: FileChange[]; both: Set<string> };
}

export interface CompareViewSnapshot {
  open: boolean;
  description: string;
  message: string | undefined;
  pair: Pair | null;
  mode: CompareMode;
  roots: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = (n: string) => n.replace(/^origin\//, "");

/**
 * Compare Branches, as a native tree in the Polylog panel: each ticked repository whose two
 * branches hold different files, then each side's changes since the split (Files) or its
 * commits (Commits). Files get the user's icon theme; a file opens its diff in the editor.
 */
export class CompareView implements vscode.TreeDataProvider<CNode>, vscode.FileDecorationProvider, vscode.Disposable {
  static readonly viewType = "polylog.compare";
  private readonly view: vscode.TreeView<CNode>;
  private readonly emitter = new vscode.EventEmitter<CNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  private readonly details = new Map<string, Detail>();
  private readonly decorations = new Map<string, vscode.FileDecoration>();
  /** Compare with…: the left branch, waiting for the right one. */
  private pending: Pair | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  /** Repositories whose branches moved; vscode.git reports one several times in a burst. */
  private readonly touched = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: { context: vscode.ExtensionContext; store: CompareStore; log: LogView }) {
    this.view = vscode.window.createTreeView(CompareView.viewType, { treeDataProvider: this, showCollapseAll: true });
    this.disposables.push(
      this.view,
      deps.store.onDidChange(() => this.changed()),
      // Hidden: its reads stop. Shown again: the remembered pair is read again (nothing is kept).
      this.view.onDidChangeVisibility(() => (this.view.visible ? void this.start() : void deps.store.setPair(null))),
      deps.log.onDidChangeRefs((id) => this.refsMoved(id)),
    );
    void this.setContext();
    if (this.view.visible) void this.start();
  }

  private get state(): vscode.Memento {
    return this.deps.context.workspaceState;
  }
  get mode(): CompareMode {
    return this.state.get<CompareMode>(MODE, "files");
  }

  private async start(): Promise<void> {
    // At startup the Log's first page comes first: Compare's reads (four per repository) wait.
    // A hidden Log has no first page: then 3 s at most.
    await Promise.race([this.deps.log.firstPage, new Promise((r) => setTimeout(r, 3000))]);
    if (this.deps.store.pair || !this.view.visible) return;
    const saved = this.state.get<Pair>(PAIR);
    if (saved && validPair(saved)) await this.setPair(saved);
    else this.changed();
  }

  /** ⇄ Compare Branches…: shows the view; with no pair yet, asks for one. */
  async open(): Promise<void> {
    await vscode.commands.executeCommand(`${CompareView.viewType}.focus`);
    if (!this.deps.store.pair && !this.state.get<Pair>(PAIR)) await this.pick();
  }

  /** Compare with…: the Log's Branch box name on the left, then the right one is asked for. */
  async compareWith(left: string): Promise<void> {
    await vscode.commands.executeCommand(`${CompareView.viewType}.focus`);
    if (!validPair({ left, right: "x" })) return this.pick();
    this.pending = { left, right: "" };
    const right = await this.pickName("right");
    this.pending = null;
    if (right) await this.setPair({ left, right });
  }

  async setPair(p: Pair): Promise<void> {
    if (!validPair(p)) return;
    await this.state.update(PAIR, p);
    if (p.left !== p.right) await this.state.update(RECENT, pushRecent(this.state.get<Pair[]>(RECENT, []), p));
    this.details.clear();
    this.changed();
    await this.deps.store.setPair(p);
  }

  async swap(): Promise<void> {
    const p = this.deps.store.pair;
    if (!p) return;
    this.deps.store.swap();
    this.details.clear();
    await this.state.update(PAIR, this.deps.store.pair);
    this.changed();
  }

  async setMode(mode: CompareMode): Promise<void> {
    await this.state.update(MODE, mode);
    await this.setContext();
    this.changed();
  }

  async refresh(): Promise<void> {
    this.details.clear();
    this.changed();
    await this.deps.store.refresh();
  }

  private refsMoved(id: string | undefined): void {
    if (id === undefined) {
      this.touched.clear();
      void this.deps.store.refresh();
      return;
    }
    this.touched.add(id);
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      const ids = [...this.touched];
      this.touched.clear();
      for (const x of ids) void this.deps.store.refresh(x);
    }, 400);
  }

  private async setContext(): Promise<void> {
    await vscode.commands.executeCommand("setContext", "polylog.compareMode", this.mode);
    await vscode.commands.executeCommand("setContext", "polylog.comparePair", this.deps.store.pair !== null || this.pending !== null);
  }

  /** Pick Branches…: the left branch, then the right one, in VS Code's own Quick Pick. */
  async pick(): Promise<void> {
    const first = await this.pickItem("left");
    if (!first) return;
    if (first.kind === "pair") return this.setPair(first.pair);
    this.pending = { left: first.name, right: "" };
    this.changed();
    const right = await this.pickName("right");
    this.pending = null;
    if (right) await this.setPair({ left: first.name, right });
    else this.changed();
  }

  private async pickName(side: Side): Promise<string | undefined> {
    const it = await this.pickItem(side);
    return it?.kind === "name" ? it.name : it?.kind === "pair" ? it.pair[side] : undefined;
  }

  private pickItem(side: Side): Promise<PickerItem | undefined> {
    type Item = vscode.QuickPickItem & { item?: PickerItem };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = side === "left" ? "Compare Branches: the branch to merge from (◀)" : `Compare Branches: the branch ${this.pending?.left ? `${this.pending.left} goes into` : "it goes into"} (▶)`;
    qp.placeholder = "Type a branch name";
    qp.matchOnDescription = false;
    qp.busy = true;
    let names: { name: string; count: number }[] = [];
    const fill = () => {
      const favorites = this.state.get<string[]>(FAVORITES, []);
      const groups = pickerGroups(names, favorites, side === "left" ? this.state.get<Pair[]>(RECENT, []) : [], "");
      qp.items = groups.flatMap((g): Item[] => [
        { label: g.title, kind: vscode.QuickPickItemKind.Separator },
        ...g.items.map((item): Item => item.kind === "pair"
          ? { label: `$(history) ${item.pair.left}  ↔  ${item.pair.right}`, item }
          : {
            label: item.name, description: `in ${plural(item.count, "repository", "repositories")}`, item,
            buttons: [{ iconPath: new vscode.ThemeIcon(item.favorite ? "star-full" : "star-empty"), tooltip: item.favorite ? "Remove from Favorites" : "Add to Favorites" }],
          }),
      ]);
    };
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: PickerItem | undefined) => {
        if (done) return;
        done = true;
        resolve(v);
        qp.dispose();
      };
      qp.onDidAccept(() => finish(qp.selectedItems[0]?.item));
      qp.onDidHide(() => finish(undefined));
      qp.onDidTriggerItemButton(async (e) => {
        const it = e.item.item;
        if (it?.kind !== "name") return;
        const favs = new Set(this.state.get<string[]>(FAVORITES, []));
        if (favs.has(it.name)) favs.delete(it.name);
        else favs.add(it.name);
        await this.state.update(FAVORITES, [...favs]);
        fill();
      });
      qp.show();
      void this.deps.store.readBranches().then((n) => {
        names = n;
        qp.busy = false;
        fill();
      }, () => (qp.busy = false));
    });
  }

  /** Opens a Files-mode file's diff: the merge base ↔ that side's tip. */
  async openFile(arg: unknown): Promise<void> {
    const a = arg as { repoId?: unknown; side?: unknown; path?: unknown } | undefined;
    if (typeof a?.repoId !== "string" || (a.side !== "left" && a.side !== "right") || typeof a.path !== "string") return;
    const hit = this.deps.store.results().find((x) => x.repo.id === a.repoId);
    const files = this.details.get(a.repoId as string)?.files?.[a.side];
    const f = files?.find((x) => x.path === a.path);
    if (!hit || hit.result.kind !== "differs" || !f || !this.deps.store.pair) return;
    const tip = a.side === "left" ? hit.result.leftSha : hit.result.rightSha;
    await this.deps.log.openDiff({ repoId: hit.repo.id, sha: tip, parent: hit.result.base, path: f.path, oldPath: f.oldPath, status: f.status }, false,
      `${path.posix.basename(f.path)} (merge base ↔ ${short(this.deps.store.pair[a.side])}) — ${hit.repo.name}`);
  }

  private changed(): void {
    // A repository whose branches moved since its detail was read is read again when shown.
    for (const [id, d] of this.details) if (d.key !== this.resultKey(id)) this.details.delete(id);
    const pair = this.deps.store.pair ?? this.pending;
    this.view.description = tabTitle(pair);
    const ticked = this.deps.log.tickedRepos().length;
    const results = this.deps.store.results();
    this.view.message = !pair ? undefined
      : pair.left && pair.left === pair.right ? `Pick two different branches. Both sides are ${pair.left}.`
      : !pair.right ? `Pick the branch ${pair.left} goes into (▶).`
      : ticked === 0 ? "No repositories are ticked in the Repo List."
      : this.deps.store.reading ? `Reading ${plural(ticked, "repository", "repositories")}… ${results.length > 0 ? summaryLabel(results.map((x) => x.result), ticked) : ""}`.trim()
      : summaryLabel(results.map((x) => x.result), ticked);
    void this.setContext();
    this.emitter.fire(undefined);
  }

  private resultKey(repoId: string): string {
    const c = this.deps.store.results().find((x) => x.repo.id === repoId)?.result;
    return c?.kind === "differs" ? `${c.leftSha} ${c.rightSha} ${c.base}` : c?.kind ?? "";
  }

  private result(repoId: string): RepoCompare | undefined {
    return this.deps.store.results().find((x) => x.repo.id === repoId)?.result;
  }

  async getChildren(node?: CNode): Promise<CNode[]> {
    try {
      return await this.children(node);
    } catch (e) {
      if (!isAbortError(e)) void vscode.window.showErrorMessage(`Polylog could not compare: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  private async children(node?: CNode): Promise<CNode[]> {
    if (!node) {
      if (!this.deps.store.pair) return [];
      const rows = this.deps.store.results().filter((x) => x.result.kind !== "identical" && x.result.kind !== "missing")
        .map((x): CNode => ({ kind: "repo", id: `r:${x.repo.id}`, repoId: x.repo.id }));
      const missing = this.deps.store.results().some((x) => x.result.kind === "missing");
      return missing ? [...rows, { kind: "missing", id: "missing" }] : rows;
    }
    switch (node.kind) {
      case "repo": {
        const c = this.result(node.repoId);
        if (c?.kind !== "differs") return [];
        const kids: CNode[] = [{ kind: "side", id: `${node.id}/left`, repoId: node.repoId, side: "left" }, { kind: "side", id: `${node.id}/right`, repoId: node.repoId, side: "right" }];
        if (c.sameLeft + c.sameRight > 0) kids.push({ kind: "both", id: `${node.id}/both`, repoId: node.repoId });
        return kids;
      }
      case "side": {
        if (this.mode === "commits") {
          const commits = (await this.deps.store.readCommits(node.repoId, node.side, COMMIT_PAGE)).filter((c) => c.mark === "+");
          return commits.map((commit): CNode => ({ kind: "commit", id: `${node.id}/c:${commit.sha}`, repoId: node.repoId, side: node.side, commit }));
        }
        const f = await this.files(node.repoId);
        return this.tree(fileTree(f[node.side]), node.id, node.repoId, node.side, f.both, "");
      }
      case "both": {
        const [l, r] = await Promise.all([this.deps.store.readCommits(node.repoId, "left", COMMIT_PAGE), this.deps.store.readCommits(node.repoId, "right", COMMIT_PAGE)]);
        return pairDuplicates(l.filter((c) => c.mark === "="), r.filter((c) => c.mark === "=")).map((d, i): CNode => ({
          kind: "dup", id: `${node.id}/${i}`, label: d.subject, description: [d.left ? `◀ ${d.left.slice(0, 7)}` : "", d.right ? `▶ ${d.right.slice(0, 7)}` : ""].filter(Boolean).join(" · "),
        }));
      }
      case "folder":
        return node.children;
      case "commit": {
        const files = await this.deps.store.readCommitFiles(node.repoId, node.commit.sha);
        return files.map((file): CNode => ({ kind: "file", id: `${node.id}/f:${file.path}`, repoId: node.repoId, side: node.side, name: file.path, file, both: false, commit: { sha: node.commit.sha, parent: node.commit.parents[0] ?? null } }));
      }
      case "missing":
        return this.deps.store.results().filter((x) => x.result.kind === "missing").map((x): CNode => ({ kind: "name", id: `missing/${x.repo.id}`, label: x.repo.name }));
      default:
        return [];
    }
  }

  private async files(repoId: string): Promise<{ left: FileChange[]; right: FileChange[]; both: Set<string> }> {
    const key = this.resultKey(repoId);
    const had = this.details.get(repoId);
    if (had?.key === key && had.files) return had.files;
    const f = await this.deps.store.readFiles(repoId);
    const files = { left: f.left, right: f.right, both: new Set(f.both) };
    this.details.set(repoId, { key, files });
    return files;
  }

  private tree(nodes: readonly TreeNode[], base: string, repoId: string, side: Side, both: ReadonlySet<string>, parent: string): CNode[] {
    return nodes.map((n): CNode => {
      if (n.kind === "folder") {
        const p = parent ? `${parent}/${n.name}` : n.name;
        return { kind: "folder", id: `${base}/d:${p}`, repoId, name: n.name, path: p, count: n.count, children: this.tree(n.children, base, repoId, side, both, p) };
      }
      return { kind: "file", id: `${base}/f:${n.file.path}`, repoId, side, name: n.name, file: n.file, both: both.has(n.file.path) };
    });
  }

  private uriFor(node: { repoId: string }, p: string, extra: string): vscode.Uri {
    // A private scheme: the icon theme picks the icon from the name; nothing of today's
    // working tree (git or Problems decorations) is painted on it.
    return vscode.Uri.from({ scheme: SCHEME, path: `/${p}`, query: `${extra}:${node.repoId}` });
  }

  getTreeItem(node: CNode): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    const pair = this.deps.store.pair;
    switch (node.kind) {
      case "repo": {
        const c = this.result(node.repoId);
        const repo = this.deps.store.results().find((x) => x.repo.id === node.repoId)?.repo;
        const item = new vscode.TreeItem(repo?.name ?? node.repoId, c?.kind === "differs" ? C.Collapsed : C.None);
        item.id = node.id;
        item.iconPath = new vscode.ThemeIcon(c?.kind === "error" ? "warning" : "repo");
        item.description = c ? repoDescription(c) : "";
        item.tooltip = c?.kind === "differs" && pair
          ? `${repo?.name}: ${plural(c.left, "commit")} only on ${pair.left}, ${plural(c.right, "commit")} only on ${pair.right}, ${c.sameLeft} on both (merges not counted)`
          : c?.kind === "error" ? c.reason : item.description as string;
        item.contextValue = this.deps.log.isBehind(node.repoId) ? "compareRepo.behind" : "compareRepo";
        return item;
      }
      case "side": {
        const c = this.result(node.repoId);
        const n = c?.kind === "differs" ? (node.side === "left" ? c.left : c.right) : 0;
        const name = pair ? short(pair[node.side]) : "";
        // The arrow icon carries the side (left blue, right yellow).
        const item = new vscode.TreeItem(`${name} only`, C.Expanded);
        item.id = node.id;
        const filesRead = this.details.get(node.repoId)?.files?.[node.side];
        item.description = this.mode === "commits" ? plural(n, "commit") : filesRead ? plural(filesRead.length, "file") : "";
        item.tooltip = node.side === "left" ? `What the merge brings in: changes on ${pair?.left} since the branches split` : `On ${pair?.right}, missing from ${pair?.left}`;
        item.iconPath = new vscode.ThemeIcon(node.side === "left" ? "arrow-left" : "arrow-right", new vscode.ThemeColor(node.side === "left" ? "charts.blue" : "charts.yellow"));
        return item;
      }
      case "both": {
        const c = this.result(node.repoId);
        const item = new vscode.TreeItem("= on both", C.Collapsed);
        item.id = node.id;
        item.description = c?.kind === "differs" ? String(c.sameLeft) : "";
        item.tooltip = "The same change committed on each side (cherry-picked): the merge does not repeat it, but history lists it twice";
        item.iconPath = new vscode.ThemeIcon("git-compare", new vscode.ThemeColor("charts.green"));
        return item;
      }
      case "folder": {
        const item = new vscode.TreeItem(node.name, C.Expanded);
        item.id = node.id;
        item.description = String(node.count);
        item.resourceUri = this.uriFor(node, node.path, "d");
        item.iconPath = vscode.ThemeIcon.Folder;
        return item;
      }
      case "file": {
        const item = new vscode.TreeItem(node.name, C.None);
        item.id = node.id;
        item.description = node.both ? `${stat(node.file)} · both` : stat(node.file);
        item.tooltip = node.both
          ? `${node.file.path}: changed on both sides since the split — look at it before merging`
          : node.file.oldPath ? `${node.file.oldPath} → ${node.file.path}` : node.file.path;
        item.resourceUri = this.uriFor(node, node.file.path, `${node.side}:${node.commit?.sha ?? ""}`);
        item.iconPath = vscode.ThemeIcon.File;
        const dec = decorationFor(node.file.status);
        if (dec) this.decorations.set(item.resourceUri.toString(), new vscode.FileDecoration(dec.badge, dec.tooltip, new vscode.ThemeColor(dec.color)));
        item.command = node.commit
          ? { command: "polylog.openDiff", title: "Open Diff", arguments: [{ repoId: node.repoId, sha: node.commit.sha, parent: node.commit.parent, path: node.file.path, oldPath: node.file.oldPath, status: node.file.status } satisfies OpenDiffArgs] }
          : { command: "polylog.compareOpenFile", title: "Open Diff", arguments: [{ repoId: node.repoId, side: node.side, path: node.file.path }] };
        return item;
      }
      case "commit": {
        const item = new vscode.TreeItem(node.commit.subject, C.Collapsed);
        item.id = node.id;
        item.description = `${node.commit.author} · ${node.commit.sha.slice(0, 7)}`;
        item.tooltip = `${node.commit.subject}\n${node.commit.author} · ${new Date(node.commit.time * 1000).toLocaleString()}`;
        item.iconPath = new vscode.ThemeIcon("git-commit");
        return item;
      }
      case "dup": {
        const item = new vscode.TreeItem(node.label, C.None);
        item.id = node.id;
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon("git-compare");
        return item;
      }
      case "missing": {
        const n = this.deps.store.results().filter((x) => x.result.kind === "missing").length;
        const item = new vscode.TreeItem("Missing a branch", C.Collapsed);
        item.id = node.id;
        item.description = plural(n, "repository", "repositories");
        item.tooltip = pair ? `${pair.left} or ${pair.right} is missing in these repositories` : "";
        item.iconPath = new vscode.ThemeIcon("circle-slash");
        return item;
      }
      case "name": {
        const item = new vscode.TreeItem(node.label, C.None);
        item.id = node.id;
        return item;
      }
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return uri.scheme === SCHEME ? this.decorations.get(uri.toString()) : undefined;
  }

  /** The view as text, with one repository's subtree read in full (integration test seam). */
  async snapshot(expandRepo?: string): Promise<CompareViewSnapshot & { tree: string[] }> {
    const lines: string[] = [];
    const walk = async (nodes: CNode[], depth: number): Promise<void> => {
      for (const n of nodes) {
        // Children first: a side's description counts the files its read found.
        const open = (n.kind !== "repo" || n.repoId === expandRepo) && n.kind !== "commit" && n.kind !== "missing";
        const kids = open ? await this.getChildren(n) : [];
        const item = this.getTreeItem(n);
        const label = typeof item.label === "string" ? item.label : item.label?.label ?? "";
        lines.push(`${"  ".repeat(depth)}${label} | ${item.description ?? ""}`);
        await walk(kids, depth + 1);
      }
    };
    const roots = await this.getChildren();
    await walk(roots, 0);
    return {
      open: this.view.visible, description: this.view.description ?? "", message: this.view.message, pair: this.deps.store.pair, mode: this.mode,
      roots: roots.map((n) => {
        const item = this.getTreeItem(n);
        return `${typeof item.label === "string" ? item.label : ""} | ${item.description ?? ""}`;
      }),
      tree: lines,
    };
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
    this.decorationsChanged.dispose();
  }
}
