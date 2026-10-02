import * as path from "path";
import * as vscode from "vscode";
import { decorationFor, stat } from "./changesModel";
import type { OpenDiffArgs } from "./changesTree";
import { COMMIT_PAGE, pairDuplicates, pickerGroups, pushRecent, repoCounts, sidePage, summaryLabel, tabTitle, validPair, type Pair, type PickerItem, type RepoCompare, type Side, type SideCommit } from "./compareModel";
import type { CompareStore } from "./compareStore";
import { fileTree, type TreeNode } from "./fileTree";
import type { LogView } from "./logView";
import { isAbortError } from "./pool";
import type { FileChange, Repo } from "./types";
import { assignAccents } from "./webview/view";

const PAIR = "polylog.compare.pair";
const RECENT = "polylog.compare.recent";
const FAVORITES = "polylog.compare.favorites";
const MODE = "polylog.compare.mode";
const SHOWN = "polylog.compare.shown";
/** The Log's Repo List colors, in the same order (Uncommitted uses them too). */
const ACCENT_COLORS = ["charts.red", "charts.blue", "charts.yellow", "charts.green", "charts.purple", "terminal.ansiCyan"];
const SCHEME = "polylog-compare";

export type CompareMode = "files" | "commits";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const short = (n: string) => n.replace(/^origin\//, "");
const labelOf = (item: vscode.TreeItem) => (typeof item.label === "string" ? item.label : item.label?.label ?? "");

/** Which repository the side views show. One emitter: both sides follow it. */
export class CompareSelection implements vscode.Disposable {
  repoId: string | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  set(id: string | undefined): void {
    if (id === this.repoId) return;
    this.repoId = id;
    this.emitter.fire();
  }
  /** The mode, the pair or the selected repository's branches changed: the sides read again. */
  touch(): void {
    this.emitter.fire();
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

interface Deps {
  context: vscode.ExtensionContext;
  store: CompareStore;
  log: LogView;
  selection: CompareSelection;
}

const modeOf = (context: vscode.ExtensionContext): CompareMode => context.workspaceState.get<CompareMode>(MODE, "files");
const resultOf = (store: CompareStore, repoId: string): { repo: Repo; result: RepoCompare } | undefined => store.results().find((x) => x.repo.id === repoId);
/** The result a side's detail was read for: its two tips and their merge base. */
const keyOf = (store: CompareStore, repoId: string): string => {
  const c = resultOf(store, repoId)?.result;
  return c?.kind === "differs" ? `${c.leftSha} ${c.rightSha} ${c.base}` : c?.kind ?? "";
};

type RNode =
  | { kind: "repo"; id: string; repoId: string }
  | { kind: "dup"; id: string; label: string; description: string }
  | { kind: "missing"; id: string }
  | { kind: "name"; id: string; label: string };

/** Repositories: the ticked repositories whose files differ between the two branches. */
export class CompareRepos implements vscode.TreeDataProvider<RNode>, vscode.Disposable {
  static readonly viewType = "polylog.compare";
  private readonly view: vscode.TreeView<RNode>;
  private readonly emitter = new vscode.EventEmitter<RNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private pending: Pair | null = null;
  /** The user picked a repository: the selection stops following the first listed one. */
  private chosen = false;
  private revealTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly touched = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private nodes = new Map<string, RNode>();

  constructor(private readonly deps: Deps) {
    this.view = vscode.window.createTreeView(CompareRepos.viewType, { treeDataProvider: this, showCollapseAll: false });
    this.disposables.push(
      this.view,
      deps.store.onDidChange(() => this.changed()),
      // Hidden: its reads stop. Shown again: the remembered pair is read again (nothing is kept).
      this.view.onDidChangeVisibility(() => (this.view.visible ? void this.start() : this.stop())),
      this.view.onDidChangeSelection((e) => {
        const n = e.selection[0];
        if (n?.kind !== "repo" || n.repoId === deps.selection.repoId) return; // our own reveal
        this.chosen = true;
        deps.selection.set(n.repoId);
      }),
      deps.log.onDidChangeRefs((id) => this.refsMoved(id)),
    );
    void this.setContext();
    // The Polylog Compare tab is hidden until Compare Branches is clicked (remembered per workspace).
    void vscode.commands.executeCommand("setContext", "polylog.compareShown", this.state.get<boolean>(SHOWN, false));
    if (this.view.visible) void this.start();
  }

  private get state(): vscode.Memento {
    return this.deps.context.workspaceState;
  }
  get mode(): CompareMode {
    return modeOf(this.deps.context);
  }

  /** Shows the Polylog Compare tab and focuses Repositories (the user asked). */
  private async show(): Promise<void> {
    if (!this.state.get<boolean>(SHOWN, false)) {
      await this.state.update(SHOWN, true);
      await vscode.commands.executeCommand("setContext", "polylog.compareShown", true);
    }
    await vscode.commands.executeCommand(`${CompareRepos.viewType}.focus`);
  }

  /** × in Repositories' title: hides the Polylog Compare tab until Compare Branches is clicked again. */
  async close(): Promise<void> {
    await this.state.update(SHOWN, false);
    await vscode.commands.executeCommand("setContext", "polylog.compareShown", false);
  }

  private stop(): void {
    this.deps.selection.set(undefined);
    void this.deps.store.setPair(null);
  }

  private async start(): Promise<void> {
    // At startup the Log's first page comes first (3 s at most when the Log is hidden).
    await Promise.race([this.deps.log.firstPage, new Promise((r) => setTimeout(r, 3000))]);
    if (this.deps.store.pair || !this.view.visible) return;
    const saved = this.state.get<Pair>(PAIR);
    if (saved && validPair(saved)) await this.setPair(saved);
    else this.changed();
  }

  /** ⇄ Compare Branches…: shows the Polylog Compare tab; with no pair yet, asks for one. */
  async open(): Promise<void> {
    await this.show();
    if (!this.deps.store.pair && !this.state.get<Pair>(PAIR)) await this.pick();
  }

  async compareWith(left: string): Promise<void> {
    await this.show();
    if (!validPair({ left, right: "x" })) return this.pick();
    this.pending = { left, right: "" };
    this.changed();
    const right = await this.pickName("right");
    this.pending = null;
    if (right) await this.setPair({ left, right });
    else this.changed();
  }

  async setPair(p: Pair): Promise<void> {
    if (!validPair(p)) return;
    await this.state.update(PAIR, p);
    if (p.left !== p.right) await this.state.update(RECENT, pushRecent(this.state.get<Pair[]>(RECENT, []), p));
    // The old pair's files leave the sides at once.
    this.chosen = false;
    this.deps.selection.set(undefined);
    this.changed();
    await this.deps.store.setPair(p);
  }

  async swap(): Promise<void> {
    if (!this.deps.store.pair) return;
    this.deps.store.swap();
    await this.state.update(PAIR, this.deps.store.pair);
    this.changed();
    this.deps.selection.touch();
  }

  async setMode(mode: CompareMode): Promise<void> {
    await this.state.update(MODE, mode);
    await this.setContext();
    this.deps.selection.touch();
  }

  async refresh(): Promise<void> {
    await this.deps.store.refresh();
    this.deps.selection.touch();
  }

  /** Selects a repository row (test seam; a click does the same through the view). */
  select(repoId: string): void {
    if (!resultOf(this.deps.store, repoId)) return;
    this.chosen = true;
    this.deps.selection.set(repoId);
    const n = this.nodes.get(repoId);
    if (n && this.view.visible) void this.view.reveal(n, { select: true, focus: false });
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

  private changed(): void {
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
    // The selection stays on its repository while it is listed, else the first one; the sides follow.
    const listed = this.listed();
    const sel = this.deps.selection.repoId;
    if (pair && pair.right && pair.left !== pair.right) {
      // Until the user picks one, the selection is the first listed repository (repositories answer
      // in any order). A side whose repository's branches moved reads again on its own (its key changed).
      if (!this.chosen || !sel || !listed.some((x) => x.repo.id === sel)) {
        if (sel && !listed.some((x) => x.repo.id === sel)) this.chosen = false;
        this.deps.selection.set(listed[0]?.repo.id);
      }
    }
    this.revealSoon();
    void this.setContext();
    this.emitter.fire(undefined);
  }

  /** Highlights the selected repository's row (after the tree has drawn the new rows). */
  private revealSoon(): void {
    clearTimeout(this.revealTimer);
    this.revealTimer = setTimeout(() => {
      const id = this.deps.selection.repoId;
      const n = id ? this.nodes.get(id) : undefined;
      if (n && this.view.visible && this.view.selection[0]?.id !== n.id) void Promise.resolve(this.view.reveal(n, { select: true, focus: false })).catch(() => undefined);
    }, 120);
  }

  private listed() {
    return this.deps.store.results().filter((x) => x.result.kind !== "identical" && x.result.kind !== "missing");
  }

  getParent(): RNode | undefined {
    return undefined;
  }

  async getChildren(node?: RNode): Promise<RNode[]> {
    try {
      if (!node) {
        if (!this.deps.store.pair) return [];
        this.nodes = new Map();
        const rows = this.listed().map((x): RNode => {
          const n: RNode = { kind: "repo", id: `r:${x.repo.id}`, repoId: x.repo.id };
          this.nodes.set(x.repo.id, n);
          return n;
        });
        // The rows exist now: highlight the selected one.
        this.revealSoon();
        return this.deps.store.results().some((x) => x.result.kind === "missing") ? [...rows, { kind: "missing", id: "missing" }] : rows;
      }
      if (node.kind === "repo") {
        const [l, r] = await Promise.all([this.deps.store.readCommits(node.repoId, "left", COMMIT_PAGE), this.deps.store.readCommits(node.repoId, "right", COMMIT_PAGE)]);
        return pairDuplicates(l.filter((c) => c.mark === "="), r.filter((c) => c.mark === "=")).map((d, i): RNode => ({
          kind: "dup", id: `${node.id}/${i}`, label: d.subject, description: [d.left ? `◀ ${d.left.slice(0, 7)}` : "", d.right ? `▶ ${d.right.slice(0, 7)}` : ""].filter(Boolean).join(" · "),
        }));
      }
      if (node.kind === "missing") {
        return this.deps.store.results().filter((x) => x.result.kind === "missing").map((x): RNode => ({ kind: "name", id: `missing/${x.repo.id}`, label: x.repo.name }));
      }
      return [];
    } catch (e) {
      if (!isAbortError(e)) void vscode.window.showErrorMessage(`Polylog could not compare: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  getTreeItem(node: RNode): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    const pair = this.deps.store.pair;
    switch (node.kind) {
      case "repo": {
        const hit = resultOf(this.deps.store, node.repoId);
        const c = hit?.result;
        const dups = c?.kind === "differs" && c.sameLeft + c.sameRight > 0;
        const item = new vscode.TreeItem(hit?.repo.name ?? node.repoId, dups ? C.Collapsed : C.None);
        item.id = node.id;
        // As in the Log's Repo List: the repository's own color.
        const accent = assignAccents(this.deps.log.repoList).get(node.repoId) ?? 0;
        item.iconPath = c?.kind === "error" ? new vscode.ThemeIcon("warning") : new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor(ACCENT_COLORS[accent % ACCENT_COLORS.length]));
        item.description = c ? repoCounts(c) : "";
        item.tooltip = c?.kind === "differs" && pair
          ? `${hit?.repo.name}: ${plural(c.left, "commit")} only on ${pair.left}, ${c.right} only on ${pair.right}, ${c.sameLeft} on both (merges not counted)`
          : c?.kind === "error" ? c.reason : String(item.description);
        item.contextValue = this.deps.log.isBehind(node.repoId) ? "compareRepo.behind" : "compareRepo";
        return item;
      }
      case "dup": {
        const item = new vscode.TreeItem(node.label, C.None);
        item.id = node.id;
        item.description = node.description;
        item.iconPath = new vscode.ThemeIcon("git-compare", new vscode.ThemeColor("charts.green"));
        item.tooltip = "The same change committed on each side (cherry-picked): the merge does not repeat it, but history lists it twice";
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

  async snapshot(): Promise<{ open: boolean; description: string; message: string | undefined; pair: Pair | null; mode: CompareMode; roots: string[]; selected: string | undefined; icons: string[] }> {
    const roots = await this.getChildren();
    const icons = roots.filter((n) => n.kind === "repo").map((n) => {
      const icon = this.getTreeItem(n).iconPath as vscode.ThemeIcon;
      return `${icon.id} ${(icon.color as { id?: string } | undefined)?.id ?? ""}`;
    });
    return {
      open: this.view.visible, description: this.view.description ?? "", message: this.view.message, pair: this.deps.store.pair, mode: this.mode,
      roots: roots.filter((n) => n.kind === "repo").map((n) => {
        const item = this.getTreeItem(n);
        return `${labelOf(item)} | ${item.description ?? ""}`;
      }),
      selected: this.deps.selection.repoId,
      icons,
    };
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    clearTimeout(this.revealTimer);
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }
}

type SNode =
  | { kind: "folder"; id: string; name: string; path: string; count: number; children: SNode[] }
  | { kind: "file"; id: string; repoId: string; name: string; file: FileChange; both: boolean; commit?: { sha: string; parent: string | null } }
  | { kind: "commit"; id: string; repoId: string; commit: SideCommit }
  | { kind: "more"; id: string };

/** One side of the selected repository: its files since the split (Files) or its commits (Commits). */
export class CompareSide implements vscode.TreeDataProvider<SNode>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly view: vscode.TreeView<SNode>;
  private readonly emitter = new vscode.EventEmitter<SNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  private readonly decorations = new Map<string, vscode.FileDecoration>();
  /** The selected repository's detail, for the result it was read for (dropped when that moves). */
  private detail: { repoId: string; key: string; mode: CompareMode; limit: number; tip: string; files?: FileChange[]; both?: Set<string>; commits?: SideCommit[]; more?: boolean } | undefined;
  private limit = COMMIT_PAGE;
  /** The read in flight, for what it was asked: asked again for the same, it is not started again. */
  private reading: { ask: string; read: Promise<NonNullable<CompareSide["detail"]> | undefined> } | undefined;
  /** What the tree last drew: a store change that leaves it the same redraws only the header. */
  private drawn: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly side: Side, private readonly deps: Deps) {
    this.view = vscode.window.createTreeView(side === "left" ? "polylog.compareLeft" : "polylog.compareRight", { treeDataProvider: this, showCollapseAll: true });
    this.disposables.push(
      this.view,
      deps.selection.onDidChange(() => {
        this.limit = COMMIT_PAGE;
        this.detail = undefined;
        this.render();
      }),
      deps.store.onDidChange(() => this.render()),
      // Collapsed or hidden: nothing to read; shown again: the selection is read.
      this.view.onDidChangeVisibility(() => this.view.visible && this.render()),
    );
    this.render();
  }

  private get mode(): CompareMode {
    return modeOf(this.deps.context);
  }

  private render(): void {
    const pair = this.deps.store.pair;
    const repoId = this.deps.selection.repoId;
    // VS Code title-cases view titles: the branch name goes in the description, as typed.
    const only = pair ? `${short(pair[this.side])} only` : "";
    const hit = repoId ? resultOf(this.deps.store, repoId) : undefined;
    if (this.detail && (this.detail.repoId !== repoId || this.detail.key !== (repoId ? keyOf(this.deps.store, repoId) : "") || this.detail.mode !== this.mode)) this.detail = undefined;
    const n = this.detail ? (this.mode === "files" ? this.detail.files?.length ?? 0 : this.detail.commits?.length ?? 0) : undefined;
    this.view.description = [only, hit ? `${hit.repo.name}${n === undefined ? "" : ` · ${plural(n, this.mode === "files" ? "file" : "commit")}`}` : ""].filter(Boolean).join(" · ");
    this.view.message = !pair || !repoId ? "Select a repository in Repositories."
      : hit?.result.kind === "nobase" ? `${hit.repo.name}: the two branches share no history, so there is no split point.`
      : hit?.result.kind === "error" ? `${hit.repo.name}: git could not compare the branches: ${hit.result.reason}`
      : n === 0 ? "No changes on this side." : undefined;
    const ask = this.ask();
    if (ask === this.drawn) return;
    this.drawn = ask;
    this.emitter.fire(undefined);
  }

  /** What this side shows: the pair, the repository, its result, the mode and the page. */
  private ask(): string {
    const p = this.deps.store.pair;
    const repoId = this.deps.selection.repoId ?? "";
    return [p?.left, p?.right, repoId, repoId ? keyOf(this.deps.store, repoId) : "", this.mode, this.limit].join("\0");
  }

  /** The selected repository's detail, read once per result and mode. */
  private read(): Promise<NonNullable<CompareSide["detail"]> | undefined> {
    const repoId = this.deps.selection.repoId;
    const hit = repoId ? resultOf(this.deps.store, repoId) : undefined;
    if (!repoId || hit?.result.kind !== "differs") return Promise.resolve(undefined);
    const key = keyOf(this.deps.store, repoId);
    const mode = this.mode;
    const limit = this.limit;
    if (this.detail?.repoId === repoId && this.detail.key === key && this.detail.mode === mode && this.detail.limit === limit) return Promise.resolve(this.detail);
    const ask = this.ask();
    if (this.reading?.ask === ask) return this.reading.read;
    const tip = this.side === "left" ? hit.result.leftSha : hit.result.rightSha;
    const read = (async () => {
      let d: NonNullable<CompareSide["detail"]>;
      if (mode === "files") {
        const f = await this.deps.store.readFiles(repoId);
        d = { repoId, key, mode, limit, tip, files: f[this.side], both: new Set(f.both) };
      } else {
        const page = sidePage(await this.deps.store.readCommits(repoId, this.side, limit + 1), limit);
        d = { repoId, key, mode, limit, tip, commits: page.rows, more: page.more };
      }
      // Asked for something else meanwhile (another repository, pair, mode or result): dropped.
      if (this.ask() !== ask) return undefined;
      this.detail = d;
      this.newDecorations();
      // The description and "no changes" message need the count: draw them, not the rows again.
      queueMicrotask(() => this.renderHeader());
      return d;
    })();
    this.reading = { ask, read };
    void read.finally(() => {
      if (this.reading?.read === read) this.reading = undefined;
    }).catch(() => undefined);
    return read;
  }

  /** A new detail: the badges are its own (VS Code asks again for the URIs it is told changed). */
  private newDecorations(): void {
    const old = [...this.decorations.keys()].map((u) => vscode.Uri.parse(u));
    this.decorations.clear();
    if (old.length > 0) this.decorationsChanged.fire(old);
  }

  private renderHeader(): void {
    const before = this.view.message;
    const hit = this.detail ? resultOf(this.deps.store, this.detail.repoId) : undefined;
    const n = this.mode === "files" ? this.detail?.files?.length : this.detail?.commits?.length;
    const pair = this.deps.store.pair;
    if (hit && n !== undefined) {
      this.view.description = `${pair ? `${short(pair[this.side])} only · ` : ""}${hit.repo.name} · ${plural(n, this.mode === "files" ? "file" : "commit")}`;
      this.view.message = n === 0 ? "No changes on this side." : before === "No changes on this side." ? undefined : before;
    }
  }

  async getChildren(node?: SNode): Promise<SNode[]> {
    try {
      if (!node) {
        if (!this.view.visible) return [];
        const d = await this.read();
        if (!d) return [];
        if (d.mode === "files") return this.tree(fileTree(d.files ?? []), `${d.repoId}/${this.side}`, d.repoId, d.both ?? new Set(), "");
        const rows = (d.commits ?? []).map((commit): SNode => ({ kind: "commit", id: `${d.repoId}/${this.side}/c:${commit.sha}`, repoId: d.repoId, commit }));
        return d.more ? [...rows, { kind: "more", id: "more" }] : rows;
      }
      if (node.kind === "folder") return node.children;
      if (node.kind === "commit") {
        const files = await this.deps.store.readCommitFiles(node.repoId, node.commit.sha);
        return files.map((file): SNode => ({ kind: "file", id: `${node.id}/f:${file.path}`, repoId: node.repoId, name: file.path, file, both: false, commit: { sha: node.commit.sha, parent: node.commit.parents[0] ?? null } }));
      }
      return [];
    } catch (e) {
      if (!isAbortError(e)) void vscode.window.showErrorMessage(`Polylog could not read ${this.side === "left" ? "the left" : "the right"} side: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  private tree(nodes: readonly TreeNode[], base: string, repoId: string, both: ReadonlySet<string>, parent: string): SNode[] {
    return nodes.map((n): SNode => {
      if (n.kind === "folder") {
        const p = parent ? `${parent}/${n.name}` : n.name;
        return { kind: "folder", id: `${base}/d:${p}`, name: n.name, path: p, count: n.count, children: this.tree(n.children, base, repoId, both, p) };
      }
      return { kind: "file", id: `${base}/f:${n.file.path}`, repoId, name: n.name, file: n.file, both: both.has(n.file.path) };
    });
  }

  getTreeItem(node: SNode): vscode.TreeItem {
    const C = vscode.TreeItemCollapsibleState;
    switch (node.kind) {
      case "folder": {
        const item = new vscode.TreeItem(node.name, C.Expanded);
        item.id = node.id;
        item.description = String(node.count);
        item.resourceUri = vscode.Uri.from({ scheme: SCHEME, path: `/${node.path}`, query: `d:${this.side}` });
        item.iconPath = vscode.ThemeIcon.Folder;
        return item;
      }
      case "file": {
        const item = new vscode.TreeItem(node.name, C.None);
        item.id = node.id;
        item.description = node.both ? `${stat(node.file)} · both` : stat(node.file);
        item.tooltip = node.both ? `${node.file.path}: changed on both sides since the split — look at it before merging`
          : node.file.oldPath ? `${node.file.oldPath} → ${node.file.path}` : node.file.path;
        // A private scheme: the icon theme picks the icon from the name; nothing of today's working tree is painted on it.
        // The tip (Files) or commit (Commits) in the URI: another result is another URI, so its badge is asked for afresh.
        item.resourceUri = vscode.Uri.from({ scheme: SCHEME, path: `/${node.file.path}`, query: `${this.side}:${node.commit?.sha ?? this.detail?.tip ?? ""}:${node.repoId}` });
        item.iconPath = vscode.ThemeIcon.File;
        const dec = decorationFor(node.file.status);
        if (dec) this.decorations.set(item.resourceUri.toString(), new vscode.FileDecoration(dec.badge, dec.tooltip, new vscode.ThemeColor(dec.color)));
        item.command = node.commit
          ? { command: "polylog.openDiff", title: "Open Diff", arguments: [{ repoId: node.repoId, sha: node.commit.sha, parent: node.commit.parent, path: node.file.path, oldPath: node.file.oldPath, status: node.file.status } satisfies OpenDiffArgs] }
          : { command: "polylog.compareOpenFile", title: "Open Diff", arguments: [{ side: this.side, repoId: node.repoId, path: node.file.path }] };
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
      case "more": {
        const item = new vscode.TreeItem(`Show ${COMMIT_PAGE} more`, C.None);
        item.id = node.id;
        item.command = { command: "polylog.compareMore", title: "Show more", arguments: [this.side] };
        return item;
      }
    }
  }

  /** Show 500 more commits on this side. */
  more(): void {
    this.limit += COMMIT_PAGE;
    this.detail = undefined;
    this.render();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return uri.scheme === SCHEME ? this.decorations.get(uri.toString()) : undefined;
  }

  /** A Files-mode file: the merge base ↔ this side's tip. Only a file of the repository shown here opens. */
  async openFile(arg: unknown): Promise<void> {
    const a = arg as { repoId?: unknown; path?: unknown } | undefined;
    const d = this.detail;
    if (!d || d.mode !== "files" || a?.repoId !== d.repoId || typeof a.path !== "string") return;
    const f = d.files?.find((x) => x.path === a.path);
    const hit = resultOf(this.deps.store, d.repoId);
    const pair = this.deps.store.pair;
    if (!f || hit?.result.kind !== "differs" || !pair) return;
    const tip = this.side === "left" ? hit.result.leftSha : hit.result.rightSha;
    await this.deps.log.openDiff({ repoId: d.repoId, sha: tip, parent: hit.result.base, path: f.path, oldPath: f.oldPath, status: f.status }, false,
      `${path.posix.basename(f.path)} (merge base ↔ ${short(pair[this.side])}) — ${hit.repo.name}`);
  }

  async snapshot(): Promise<{ open: boolean; title: string; description: string; message: string | undefined; tree: string[]; files: string[] }> {
    const lines: string[] = [];
    /** "<path> <resourceUri> <badge>" for every file row (test seam). */
    const files: string[] = [];
    const walk = async (nodes: SNode[], depth: number): Promise<void> => {
      for (const n of nodes) {
        const kids = n.kind === "folder" || n.kind === "commit" ? await this.getChildren(n) : [];
        const item = this.getTreeItem(n);
        lines.push(`${"  ".repeat(depth)}${labelOf(item)} | ${item.description ?? ""}`);
        if (n.kind === "file" && item.resourceUri) files.push(`${n.file.path} ${item.resourceUri.toString()} ${this.provideFileDecoration(item.resourceUri)?.badge ?? ""}`);
        await walk(kids, depth + 1);
      }
    };
    await walk(await this.getChildren(), 0);
    this.renderHeader();
    return { open: this.view.visible, title: this.view.description?.split(" · ")[0] ?? "", description: this.view.description?.split(" · ").slice(1).join(" · ") ?? "", message: this.view.message, tree: lines, files };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
    this.decorationsChanged.dispose();
  }
}
