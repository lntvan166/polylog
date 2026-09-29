import { randomBytes } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { firstOpenable } from "./changesModel";
import type { ChangesSnapshot, ChangesTree, OpenDiffArgs } from "./changesTree";
import { diffSides, parseShow, showArgs } from "./commitDetail";
import { debounce } from "./debounce";
import { DEFAULT_FILTER, normalizePath, pathspecOf, sameExceptText, sanitizeFilter, selectRepos, type FilterState } from "./filterModel";
import { fetchPage, type BranchUse, type QueryState, type RunGit } from "./logQuery";
import { isAbortError, runPool } from "./pool";
import type { AuthorName, BranchName, HostMessage, Layout, WebviewMessage } from "./protocol";
import type { RepoDiscovery } from "./repoDiscovery";
import { decodeRevision, encodeRevision, SCHEME, workingFile, type RevisionRef } from "./revisionUri";
import { commitWebUrl } from "./remoteUrl";
import { addExclusion, authorSuggestions, branchSuggestions, undoExclusion } from "./repos";
import { readSettings } from "./settings";
import { commitKey, isSha, UNCOMMITTED, type Commit, type FileChange, type Repo, type RepoFailure } from "./types";
import { aheadBehindArgs, behindRepos, FETCH_ENV, fetchArgs, parseAheadBehind, type AheadBehind } from "./upstream";
import { headOf, numstatArgs, parseNumstat, parseStatus, statusArgs, uncommittedFiles } from "./workingTree";
import { renderHtml } from "./webview/html";

const FILTER_KEY = "polylog.filter";
/** globalState: true when the user turned Group by Repository off. */
export const HIDE_REPOS_KEY = "polylog.hideRepos";
/** globalState: the Repositories pane width the user dragged to. */
const PANE_WIDTH_KEY = "polylog.repoPaneWidth";
const DEFAULT_PANE_WIDTH = 190;
/** Fetch All: network-bound, so fewer at once than the log reads; and a fetch that hangs stops. */
const FETCH_CONCURRENCY = 8;
const FETCH_TIMEOUT_MS = 60_000;
/** Without it, typing a six-character term launches 408 child processes. */
const SEARCH_DEBOUNCE_MS = 250;

export interface LogDeps {
  discovery: RepoDiscovery;
  run: RunGit;
  changes: ChangesTree;
}

export interface LogSnapshot {
  repos: Repo[];
  filter: FilterState;
  rows: Commit[];
  failures: RepoFailure[];
  done: boolean;
  /** How many times the webview (re)loaded; hiding and showing the panel must not reload it. */
  readyCount: number;
  /** Each repository's user.email, in repo order (test seam). */
  me: string[];
  history: { repoId: string; path: string } | null;
  /** Review Uncommitted is open. */
  review: boolean;
  /** What a window reload would restore. */
  persistedFilter: FilterState | undefined;
  branches: BranchName[];
  authors: AuthorName[];
  branchUse: BranchUse | undefined;
  changes: ChangesSnapshot;
  /** The native Changes view is expanded and on screen (keepExpanded test seam). */
  changesVisible: boolean;
  layout: Layout;
  stats: { msToFirstRows: number | null; reloads: number; discoveries: number; spawns: number; discoveryMs: number; fetchMs: number; msToResolve: number; msToReady: number };
  /** Each git process started: in which repository, and which subcommand (the last 2,000). */
  spawnLog: { root: string; cmd: string }[];
  /** Each repository's distance from its upstream (only those with one). */
  sync: Record<string, AheadBehind>;
  /** Repositories VS Code's Git reports changes for (the others are always read again). */
  reported: string[];
  /** Messages posted to the webview, by type, and their total size in bytes (integration runs only). */
  posts: Record<string, { count: number; bytes: number }>;
}

/** Posts are measured only in integration runs: sizing a 1 MB page costs milliseconds. */
const MEASURE_POSTS = process.env.POLYLOG_ITEST === "1";

const nowSec = () => Math.floor(Date.now() / 1000);

/** One repository's uncommitted changes; `seq` orders reads of it. */
interface Working { head: string | null; files: FileChange[]; seq: number }

/** Whether a new read shows the same row and files as the last one (then nothing is posted). */
function sameWorking(old: Pick<Working, "head" | "files"> | undefined, next: Pick<Working, "head" | "files">): boolean {
  if ((old?.files.length ?? 0) === 0 && next.files.length === 0) return true; // no row either way
  return old !== undefined && old.head === next.head && JSON.stringify(old.files) === JSON.stringify(next.files);
}
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toUri = (r: RevisionRef) => vscode.Uri.from({ scheme: SCHEME, ...encodeRevision(r) });

/** The Log view in the Polylog panel. Registered with retainContextWhenHidden (extension.ts). */
export class LogView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly id = "polylog.log";

  private webviewView: vscode.WebviewView | undefined;
  private repos: Repo[] = [];
  private filter: FilterState;
  private rows: Commit[] = [];
  private failures: RepoFailure[] = [];
  private done = true;
  private queryState: QueryState | null = null;
  private query = new AbortController();
  private detail = new AbortController();
  private loadingMore = false;
  private readyCount = 0;
  /** repo id → that repo's user.email, for the "Me" filter. Read in the background. */
  private meByRepo = new Map<string, string>();
  /** File history mode: one file of one repository. */
  private history: { repoId: string; path: string } | null = null;
  /** The history diff currently open (its modified-side URI), replaced on each step. */
  private historyTab: string | undefined;
  /** History steps swap tabs one at a time, and a step already overtaken is skipped. */
  private historySteps: Promise<void> = Promise.resolve();
  private historyStep = 0;
  /** What File History set aside (range, search, author); closing it gives them back. */
  private beforeHistory: Pick<FilterState, "date" | "from" | "to" | "text" | "author" | "mine" | "authors"> | null = null;
  /** Branch names across the workspace, for the Branch box's suggestions. Read in the background. */
  private branches: BranchName[] = [];
  /** Recent authors across the workspace, for the Author box's suggestions. Read in the background. */
  private authors: AuthorName[] = [];
  private branchUse: BranchUse | undefined;
  /** The repo set the background reads last ran for. */
  private backgroundFor: string | undefined;
  /** Enter arrived before the selected commit's files: open the first one when they land. */
  private openWhenLoaded: string | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  /** Review Uncommitted: the Log lists repositories with changes, the tree the clicked one's files. */
  private review = false;
  /** The repository whose files Review Uncommitted shows (the row clicked in the Log). */
  private reviewRepo: string | undefined;
  /** Each repository's uncommitted changes, read only while they are shown. */
  private uncommitted = new Map<string, Working>();
  /** The Path filter's pathspec the map was read under (a new one reads every repository again). */
  private uncommittedSpec: string | undefined;
  /** Orders reads of one repository: a slower, older read never replaces a newer one. */
  private uncommittedSeq = 0;
  /** The read of every repository; a newer one (or hiding the rows) aborts it. */
  private uncommittedRead = new AbortController();
  /**
   * The repositories and Path filter of the last complete read of every repository (and of the
   * one in flight). The same again reads nothing: saves and VS Code's Git events keep each
   * repository current, so a date or text change has nothing new to find. Refresh clears it.
   */
  private uncommittedDone: string | undefined;
  private uncommittedInFlight: string | undefined;
  /** The read of every repository in flight: an identical request waits for it (Review needs it whole). */
  private uncommittedReading: Promise<void> | undefined;
  /** Reads of single repositories after a save or a git event; a read of every repository aborts them. */
  private repoReads = new AbortController();
  /** Repositories whose working tree changed since the last read, read together after a burst. */
  private readonly touched = new Set<string>();
  private readonly touchedSoon = debounce(() => {
    const ids = new Set(this.touched);
    this.touched.clear();
    void this.uncommittedChanged(ids);
  }, 400);
  private readonly visibilityChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeVisibility = this.visibilityChanged.event;
  private readonly reloadSoon = debounce(() => void this.reload(), SEARCH_DEBOUNCE_MS);
  // The git extension opens repositories in bursts at startup; coalesce them.
  private readonly reposChangedSoon = debounce(() => void this.refreshRepos(), SEARCH_DEBOUNCE_MS);

  /** Startup and load cost, for the perf harness and the integration suite. */
  private readonly stats = { createdAt: Date.now(), firstRowsAt: 0, reloads: 0, discoveries: 0, spawns: 0, discoveryMs: 0, fetchMs: 0, resolvedAt: 0, readyAt: 0 };
  private readonly spawnLog: { root: string; cmd: string }[] = [];
  private readonly posts: Record<string, { count: number; bytes: number }> = {};
  private readonly run: RunGit;
  private firstLoad: Promise<void> | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly deps: LogDeps) {
    this.run = (cwd, args, signal, opts) => {
      this.stats.spawns++;
      this.spawnLog.push({ root: cwd, cmd: args[0] ?? "" });
      if (this.spawnLog.length > 2000) this.spawnLog.splice(0, this.spawnLog.length - 2000);
      return deps.run(cwd, args, signal, opts);
    };
    this.filter = sanitizeFilter(context.workspaceState.get(FILTER_KEY) ?? DEFAULT_FILTER);
    this.syncRepoFiltered();
    this.disposables.push(deps.discovery.onDidChange(() => this.reposChangedSoon()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.stats.resolvedAt = Date.now();
    // Start git while the webview's page is still loading; "ready" replays the result.
    this.firstLoad ??= (async () => {
      await this.loadRepos();
      await this.reload();
    })();
    this.webviewView = view;
    const out = vscode.Uri.joinPath(this.context.extensionUri, "out");
    view.webview.options = { enableScripts: true, localResourceRoots: [out] };
    view.webview.html = renderHtml({
      cspSource: view.webview.cspSource,
      nonce: randomBytes(16).toString("hex"),
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(out, "webview.js")).toString(),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(out, "webview.css")).toString(),
    });
    // Also a check on load: a view collapsed in an earlier session raises no event of its own.
    this.visibilityChanged.fire();
    this.disposables.push(
      view.webview.onDidReceiveMessage((m: WebviewMessage) => void this.onMessage(m)),
      view.onDidChangeVisibility(() => this.visibilityChanged.fire()),
      view.onDidDispose(() => {
        if (this.webviewView === view) this.webviewView = undefined;
      }),
    );
  }

  /** Expanded and on screen; undefined if the Log never loaded (collapsed at startup). */
  get visible(): boolean | undefined {
    return this.webviewView?.visible;
  }

  /** Expand the Log again (keepExpanded.ts); show(true) keeps focus where it is. */
  expand(): void {
    this.webviewView?.show(true);
  }

  /** show(true) needs the resolved view; a Log never loaded cannot be expanded quietly. */
  get canExpand(): boolean {
    return this.webviewView !== undefined;
  }

  async onMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case "ready":
        this.readyCount++;
        if (!this.stats.readyAt) this.stats.readyAt = Date.now();
        // The first load started when the view was created; wait for it, then
        // replay. (Also sent when a hidden webview is re-created.)
        if (this.firstLoad) await this.firstLoad;
        else await this.loadRepos();
        this.postInit();
        // A re-created webview lost the suggestions it had: send them again (only then).
        if (this.branches.length > 0 || this.authors.length > 0) this.post({ type: "suggestions", branches: this.branches, authors: this.authors });
        if (this.sync.size > 0) this.postSync();
        if (this.queryState === null) await this.reload();
        else this.post({ type: "page", rows: this.shownRows(), append: false, failures: this.failures, done: this.done, now: nowSec(), branchUse: this.branchUse });
        return;
      case "filter": {
        const next = sanitizeFilter(m.filter);
        const textOnly = sameExceptText(next, this.filter);
        this.filter = next;
        this.persistFilter();
        this.query.abort(); // kill superseded spawns now, not after the debounce
        if (textOnly) {
          this.reloadSoon();
        } else {
          this.reloadSoon.cancel();
          await this.reload();
        }
        return;
      }
      case "refresh":
        this.reloadSoon.cancel();
        this.forgetUncommittedRead();
        await this.refreshRepos(true);
        return;
      case "loadMore":
        await this.loadMore();
        return;
      case "select":
        await this.showDetail(m.repoId, m.sha);
        return;
      case "openFirst":
        await this.openFirst(m.repoId, m.sha);
        return;
      case "exitHistory":
        await this.setHistory(null);
        return;
      case "exitReview":
        await this.leaveReview();
        return;
      case "wantSuggestions":
        if (m.kind === "authors" || m.kind === "branches") await this.loadSuggestions(m.kind);
        return;
      case "layout":
        if (typeof m.repoPaneWidth === "number" && Number.isFinite(m.repoPaneWidth)) await this.context.globalState.update(PANE_WIDTH_KEY, Math.round(m.repoPaneWidth));
        return;
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "scan depth");
        return;
    }
  }

  private settings() {
    const config = vscode.workspace.getConfiguration("polylog");
    return readSettings((key) => config.get(key));
  }

  private layout(): Layout {
    const width = this.context.globalState.get<number>(PANE_WIDTH_KEY, DEFAULT_PANE_WIDTH);
    return {
      repoPaneWidth: typeof width === "number" && Number.isFinite(width) ? width : DEFAULT_PANE_WIDTH,
      groupByRepo: !this.context.globalState.get<boolean>(HIDE_REPOS_KEY, false),
    };
  }

  private postInit(): void {
    const repo = this.history && this.repos.find((r) => r.id === this.history!.repoId);
    const history = this.history && repo ? { repoName: repo.name, path: this.history.path } : null;
    this.post({ type: "init", repos: this.repos, filter: this.filter, hasMe: this.meByRepo.size > 0, layout: this.layout(), history, review: this.review ? this.reviewSummary() : null });
  }

  /**
   * "Polylog: File History" from the Explorer, an editor, a diff or the Changes
   * tree. Accepts a file: URI, a polylog: revision URI, a Changes file node, or
   * nothing (the active editor).
   */
  async fileHistory(arg?: unknown): Promise<void> {
    if (this.repos.length === 0) await this.loadRepos();
    let target: { repoId: string; path: string } | undefined;
    const fromTree = this.treeFile(arg);
    if (fromTree) {
      target = { repoId: fromTree.repo.id, path: fromTree.path };
    } else {
      const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
      if (uri?.scheme === SCHEME) {
        const rev = decodeRevision(uri.path, uri.query);
        const repo = this.repos.find((r) => r.root === rev.root);
        if (repo) target = { repoId: repo.id, path: rev.path };
      } else if (uri?.scheme === "file") {
        target = this.locate(uri.fsPath);
      }
    }
    if (!target) {
      void vscode.window.showInformationMessage("Polylog: this file is not in a repository of this workspace.");
      return;
    }
    await vscode.commands.executeCommand(`${LogView.id}.focus`);
    await this.setHistory(target);
  }

  /**
   * "Open File" on a Polylog diff, or on a file in the Changes tree: the file as it is
   * in the workspace now, at the line the diff's cursor was on.
   */
  async openWorkingFile(arg?: unknown): Promise<void> {
    if (this.repos.length === 0) await this.loadRepos();
    const roots = this.repos.map((r) => r.root);
    let file: string | undefined;
    let line: number | undefined;
    const fromTree = this.treeFile(arg);
    if (fromTree) {
      file = workingFile({ root: fromTree.repo.root, ref: null, path: fromTree.path }, roots);
    } else {
      const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
      if (uri?.scheme === SCHEME) {
        try {
          file = workingFile(decodeRevision(uri.path, uri.query), roots);
        } catch {
          file = undefined;
        }
        const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
        line = editor?.selection.active.line;
      }
    }
    if (!file) {
      void vscode.window.showInformationMessage("Polylog: this file is not in a repository of this workspace.");
      return;
    }
    const target = vscode.Uri.file(file);
    try {
      await vscode.workspace.fs.stat(target);
    } catch {
      void vscode.window.showInformationMessage(`Polylog: ${path.basename(file)} no longer exists in the workspace.`);
      return;
    }
    const at = line === undefined ? undefined : new vscode.Range(line, 0, line, 0);
    await vscode.window.showTextDocument(target, { preview: false, selection: at });
  }

  /**
   * A file node from the Changes tree (its right-click passes the node): which repository it
   * belongs to, and its path, if it really is a file of what the tree shows. In Review
   * Uncommitted the tree spans several repositories, so the node's own owner decides.
   */
  private treeFile(arg: unknown): { repo: Repo; path: string } | undefined {
    const node = arg as { kind?: unknown; path?: unknown; owner?: { repoId?: unknown } } | undefined;
    const current = this.deps.changes.current();
    if (!node || typeof node !== "object" || node.kind !== "file" || typeof node.path !== "string" || !current) return undefined;
    const repoId = typeof node.owner?.repoId === "string" ? node.owner.repoId : current.commit.repoId;
    const files = current.groups ? current.groups.find((g) => g.commit.repoId === repoId)?.files ?? [] : current.files;
    const repo = this.repos.find((r) => r.id === repoId);
    return repo && files.some((f) => f.path === node.path) ? { repo, path: node.path } : undefined;
  }

  /** The workspace repository containing a file (innermost first), and its repo-relative path. */
  private locate(fsPath: string): { repoId: string; path: string } | undefined {
    const inside = this.innermost(fsPath);
    return inside && inside.rel !== "" ? { repoId: inside.r.id, path: inside.rel.split(path.sep).join("/") } : undefined;
  }

  /** The innermost workspace repository at or above a path ("" when it is the root itself). */
  private innermost(fsPath: string): { r: Repo; rel: string } | undefined {
    return this.repos
      .map((r) => ({ r, rel: path.relative(r.root, fsPath) }))
      .filter((x) => x.rel !== ".." && !x.rel.startsWith(`..${path.sep}`) && !path.isAbsolute(x.rel))
      .sort((a, b) => a.rel.length - b.rel.length)[0];
  }

  /** Save the filter; while File History forces all time, save the range the user will come back to. */
  private persistFilter(): void {
    this.syncRepoFiltered();
    const saved = this.history && this.beforeHistory ? { ...this.filter, ...this.beforeHistory } : this.filter;
    void this.context.workspaceState.update(FILTER_KEY, saved);
  }

  /** The right-click menu offers Show All Repositories only while some are unticked. */
  private repoFiltered: boolean | undefined;
  private syncRepoFiltered(): void {
    const on = this.filter.repoIds !== null;
    if (on === this.repoFiltered) return;
    this.repoFiltered = on;
    void vscode.commands.executeCommand("setContext", "polylog.repoFiltered", on);
  }

  /** Leave File History without reloading: restore the date range. */
  private leaveHistory(): void {
    if (this.beforeHistory) this.filter = { ...this.filter, ...this.beforeHistory };
    this.beforeHistory = null;
    this.history = null;
    // The next File History is a new session: its first step must not close this one's diff.
    this.historyTab = undefined;
    this.persistFilter();
  }

  /**
   * File history shows every commit of the file: all time, no search, no author. Closing
   * it restores what the user had before (even if they changed it while in history).
   */
  private async setHistory(history: { repoId: string; path: string } | null): Promise<void> {
    if (history) this.review = false; // File History replaces Review Uncommitted
    if (history && !this.history) {
      const { date, from, to, text, author, mine, authors } = this.filter;
      this.beforeHistory = { date, from, to, text, author, mine, authors };
      this.filter = { ...this.filter, date: "all", from: undefined, to: undefined, text: "", author: "", mine: false, authors: undefined };
      this.history = history;
    } else if (!history) {
      this.leaveHistory();
    } else {
      this.history = history;
    }
    this.persistFilter();
    this.postInit();
    await this.reload();
  }

  /**
   * The git binary changed (git.path, or VS Code's Git extension reported its own). Kill
   * git processes still running on the old binary, and read everything again: the page,
   * the selected commit, and the background reads (Me, branch suggestions).
   */
  async gitChanged(): Promise<void> {
    this.query.abort();
    this.detail.abort();
    this.reloadSoon.cancel();
    this.backgroundFor = undefined;
    this.meFor = undefined;
    this.forgetUncommittedRead();
    this.fetchCtl.abort();
    this.fetchCtl = new AbortController();
    await this.reload();
    const current = this.deps.changes.current();
    if (current) await this.showDetail(current.commit.repoId, current.commit.sha);
  }

  /** Group by Repository: show or hide the Repositories pane (Log title-bar toggle). */
  async setGroupByRepo(on: boolean): Promise<void> {
    await this.context.globalState.update(HIDE_REPOS_KEY, !on);
    await vscode.commands.executeCommand("setContext", HIDE_REPOS_KEY, !on);
    // Hiding the pane must not leave a repo filter the user can no longer see.
    const clearing = !on && this.filter.repoIds !== null;
    if (clearing) {
      this.filter = { ...this.filter, repoIds: null };
      this.persistFilter();
    }
    this.postInit();
    if (clearing) await this.reload();
  }

  private async loadRepos(): Promise<void> {
    this.stats.discoveries++;
    const t = Date.now();
    this.repos = await this.deps.discovery.list(this.settings());
    this.stats.discoveryMs = Date.now() - t;
  }

  /**
   * "Me" emails and branch suggestions are background reads: they start after
   * the first page is on screen (so they never compete with it) and run once
   * per set of repositories.
   */
  private startBackgroundReads(): void {
    const key = this.repos.map((r) => r.id).join("\0");
    if (key === this.backgroundFor) return;
    this.backgroundFor = key;
    void this.loadMe();
    void this.readSync();
    // Suggestions are read when their box is first focused (wantSuggestions), not here:
    // at startup they would cost 2 git processes per repository for boxes rarely opened.
    this.suggestionsFor.clear();
    // A box focused before the repositories were known asked for nothing useful: ask again.
    for (const kind of this.suggestionsWanted) void this.loadSuggestions(kind);
  }

  /** Kinds of suggestion a box has asked for this session. */
  private readonly suggestionsWanted = new Set<"authors" | "branches">();

  /** The repo set each kind of suggestion was last read for. */
  private readonly suggestionsFor = new Map<"authors" | "branches", string>();

  private async loadSuggestions(kind: "authors" | "branches"): Promise<void> {
    this.suggestionsWanted.add(kind);
    if (this.repos.length === 0) return; // nothing to read yet; asked again once repos arrive
    const key = this.repos.map((r) => r.id).join("\0");
    if (this.suggestionsFor.get(kind) === key) return;
    this.suggestionsFor.set(kind, key);
    await (kind === "authors" ? this.loadAuthors() : this.loadBranches());
  }

  /** People who committed recently, for the Author box's suggestions: 300 commits per repo. */
  private async loadAuthors(): Promise<void> {
    const repos = [...this.repos];
    const settled = await runPool(repos, this.settings().maxConcurrency,
      (r, signal) => this.run(r.root, ["log", "--no-merges", "--max-count=300", "--format=%aN%x1f%aE"], signal), new AbortController().signal);
    this.authors = authorSuggestions(settled.map((s) => (s.status === "fulfilled" ? s.value : "")));
    this.post({ type: "suggestions", authors: this.authors });
  }

  /** Branch names across repositories (local and remote-tracking), most shared first. */
  private async loadBranches(): Promise<void> {
    const repos = [...this.repos];
    const settled = await runPool(repos, this.settings().maxConcurrency,
      (r, signal) => this.run(r.root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], signal), new AbortController().signal);
    const lists = settled.map((s) => s.status === "fulfilled"
      ? s.value.split("\n").map((l) => l.trim().replace(/^refs\/(heads|remotes)\//, "")).filter(Boolean)
      : []);
    this.branches = branchSuggestions(lists);
    this.post({ type: "suggestions", branches: this.branches });
  }

  /** The repo set meByRepo was read for (reset when git itself changes). */
  private meFor: string | undefined;

  /** Each repo's user.email, in the background so it never delays the first paint. */
  private async loadMe(): Promise<void> {
    if (this.meFor === this.repos.map((r) => r.id).join("\0")) return; // read before the page (Me was on)
    if (!(await this.readMe())) return;
    this.postInit();
    if (this.filter.mine) await this.reload();
  }

  /** Reads each repo's user.email; true when they changed. */
  private async readMe(): Promise<boolean> {
    const repos = [...this.repos];
    this.meFor = repos.map((r) => r.id).join("\0");
    const settled = await runPool(repos, this.settings().maxConcurrency,
      (r, signal) => this.run(r.root, ["config", "user.email"], signal), new AbortController().signal);
    const me = new Map<string, string>();
    settled.forEach((s, i) => {
      if (s.status === "fulfilled" && s.value.trim()) me.set(repos[i].id, s.value.trim());
    });
    const changed = [...me].join() !== [...this.meByRepo].join();
    this.meByRepo = me;
    return changed;
  }

  /** Repositories may have changed (vscode.git settled, a repo opened/closed): reload only if they did. */
  private async refreshRepos(force = false): Promise<void> {
    const before = this.repos.map((r) => r.id).join("\0");
    await this.loadRepos();
    let changed = this.repos.map((r) => r.id).join("\0") !== before;
    // File History's repository left the list (excluded, closed): end it, or the Log is stuck with no exit.
    if (this.history && !this.repos.some((r) => r.id === this.history!.repoId)) {
      this.leaveHistory();
      changed = true;
    }
    this.postInit();
    if (force || changed || this.queryState === null) await this.reload();
    // Refresh also re-reads how far each repo is from its upstream (a fetch may have moved it).
    if (force) void this.readSync();
  }

  /** polylog.excludeRepos or scanDepth changed in Settings: list the repositories again. */
  async reposSettingChanged(): Promise<void> {
    await this.refreshRepos();
  }

  /** Each repository's distance from its upstream, for the Repositories pane's ↓/↑ badge. */
  private sync = new Map<string, AheadBehind>();

  /**
   * Reads ahead/behind for these repositories (every one by default): one git rev-list each,
   * from local refs. Posted only when a count changed.
   */
  private async readSync(only?: ReadonlySet<string>): Promise<void> {
    const repos = only ? this.repos.filter((r) => only.has(r.id)) : [...this.repos];
    const settled = await runPool(repos, this.settings().maxConcurrency, (r, signal) => this.run(r.root, aheadBehindArgs(), signal), new AbortController().signal);
    const next = new Map(only ? this.sync : []);
    settled.forEach((s, i) => {
      const ab = s.status === "fulfilled" ? parseAheadBehind(s.value) : null;
      if (ab && (ab.ahead > 0 || ab.behind > 0)) next.set(repos[i].id, ab);
      else next.delete(repos[i].id);
    });
    for (const id of next.keys()) if (!this.repos.some((r) => r.id === id)) next.delete(id);
    const key = (m: Map<string, AheadBehind>) => JSON.stringify([...m].sort());
    if (key(next) === key(this.sync)) return;
    this.sync = next;
    this.postSync();
    void vscode.commands.executeCommand("setContext", "polylog.anyBehind", behindRepos([...next.keys()], Object.fromEntries(next)).length > 0);
  }

  private fetching: Promise<{ fetched: number; failed: string[] }> | undefined;

  /**
   * Fetch All (the Log's toolbar): git fetch in every repository, a few at a time, then read how
   * far each is from its upstream again. The only thing Polylog changes in a repository, and only
   * when asked. Never prompts (GIT_TERMINAL_PROMPT=0); a fetch that hangs stops after a minute.
   */
  fetchAll(): Promise<{ fetched: number; failed: string[] }> {
    this.fetching ??= this.runFetchAll().finally(() => (this.fetching = undefined));
    return this.fetching;
  }

  private async runFetchAll(): Promise<{ fetched: number; failed: string[] }> {
    if (this.repos.length === 0) await this.loadRepos();
    const repos = [...this.repos];
    const prune = vscode.workspace.getConfiguration("git").get<boolean>("pruneOnFetch", false) === true;
    // Network work, not disk: fewer at once than the log reads.
    const limit = Math.min(this.settings().maxConcurrency, FETCH_CONCURRENCY);
    const outer = this.fetchCtl.signal;
    const settled = await vscode.window.withProgress({ location: { viewId: LogView.id }, title: "Fetching" }, () =>
      runPool(repos, limit, (r) => this.fetchOne(r, prune, outer), outer));
    if (outer.aborted) return { fetched: 0, failed: [] }; // disposed, or git changed: say nothing
    const failed = settled.flatMap((s, i) => (s.status === "rejected" ? [{ repo: repos[i], reason: s.reason }] : []));
    if (failed.length > 0) {
      const why = (e: unknown) => (isAbortError(e) ? `no answer after ${FETCH_TIMEOUT_MS / 1000} s` : messageOf(e));
      const list = failed.slice(0, 3).map((f) => `${f.repo.name} (${why(f.reason)})`).join(", ");
      const more = failed.length > 3 ? ` and ${failed.length - 3} more` : "";
      void vscode.window.showWarningMessage(`Polylog could not fetch ${failed.length} of ${repos.length} repositories: ${list}${more}.`);
    } else {
      vscode.window.setStatusBarMessage(`Polylog: fetched ${repos.length} repositories`, 4000);
    }
    // New remote branches: the Branch box's suggestions and a branch-mode page are out of date.
    this.suggestionsFor.delete("branches");
    if (this.suggestionsWanted.has("branches")) void this.loadSuggestions("branches");
    if (this.filter.branch) await this.reload();
    await this.readSync();
    return { fetched: repos.length - failed.length, failed: failed.map((f) => f.repo.name) };
  }

  /** Aborted by dispose and by a new git binary: a fetch in flight stops, with its helpers. */
  private fetchCtl = new AbortController();

  private async fetchOne(repo: Repo, prune: boolean, outer: AbortSignal): Promise<string> {
    const ctl = new AbortController();
    const stop = () => ctl.abort();
    const timer = setTimeout(stop, FETCH_TIMEOUT_MS);
    outer.addEventListener("abort", stop, { once: true });
    try {
      // tree: a timeout also kills ssh and the credential helpers git started.
      return await this.run(repo.root, fetchArgs(prune), ctl.signal, { tree: true, env: FETCH_ENV });
    } finally {
      clearTimeout(timer);
      outer.removeEventListener("abort", stop);
    }
  }

  /** Show Only Repositories Behind: tick the repositories with commits to pull (as of the last fetch). */
  async showBehind(): Promise<void> {
    const ids = behindRepos(this.repos.map((r) => r.id), Object.fromEntries(this.sync));
    if (ids.length === 0) {
      void vscode.window.showInformationMessage("Polylog: no repository is behind its upstream (as of the last fetch).");
      return;
    }
    await this.setRepoFilter(ids);
  }

  private postSync(): void {
    this.post({ type: "sync", byRepo: Object.fromEntries(this.sync) });
  }

  /** Repositories VS Code's Git reported a change in, whose upstream distance is read again. */
  private readonly syncTouched = new Set<string>();
  private readonly syncSoon = debounce(() => {
    const ids = new Set(this.syncTouched);
    this.syncTouched.clear();
    void this.readSync(ids);
  }, 400);

  /**
   * VS Code's Git reported a new state for a repository (a save, a stage, a fetch, a pull):
   * its uncommitted changes may have moved; its distance from its upstream only if HEAD or
   * the upstream did (a save does not move them).
   */
  repoStateChanged(root: string, headMoved: boolean): void {
    this.workingTreeChanged(root);
    if (!headMoved) return;
    const repo = this.innermost(root)?.r;
    if (!repo) return;
    this.syncTouched.add(repo.id);
    this.syncSoon();
  }

  /** The repository a right-click on the Log's webview (a pane row or a commit row) was on. */
  private contextRepo(arg: unknown): Repo | undefined {
    const id = (arg as { repoId?: unknown } | undefined)?.repoId;
    return typeof id === "string" ? this.repos.find((r) => r.id === id) : undefined;
  }

  /** The commit a right-click on a Log row was on: a real commit of a listed repository. */
  private contextCommit(arg: unknown): { repo: Repo; sha: string } | undefined {
    const repo = this.contextRepo(arg);
    const sha = (arg as { sha?: unknown } | undefined)?.sha;
    return repo && typeof sha === "string" && isSha(sha) && sha !== UNCOMMITTED ? { repo, sha } : undefined;
  }

  /** Right-click a commit → Copy Commit ID. */
  async commitCopySha(arg: unknown): Promise<void> {
    const c = this.contextCommit(arg);
    if (c) await vscode.env.clipboard.writeText(c.sha);
  }

  /** Right-click a commit → Copy Message: the whole message (the row shows only the subject). */
  async commitCopyMessage(arg: unknown): Promise<void> {
    const c = this.contextCommit(arg);
    if (!c) return;
    const message = await this.run(c.repo.root, ["show", "-s", "--format=%B", c.sha, "--"], new AbortController().signal);
    await vscode.env.clipboard.writeText(message.trim());
  }

  /**
   * Right-click a commit → Open on Remote: its page on GitHub, GitLab, Bitbucket, Azure DevOps…,
   * from the repository's origin (or its first remote). Returns the URL opened.
   */
  async commitOpenOnRemote(arg: unknown): Promise<string | undefined> {
    const c = this.contextCommit(arg);
    if (!c) return undefined;
    const signal = new AbortController().signal;
    const urlOf = (name: string) => this.run(c.repo.root, ["remote", "get-url", "--", name], signal).then((s) => s.trim(), () => "");
    let remote = await urlOf("origin");
    if (!remote) {
      const names = await this.run(c.repo.root, ["remote"], signal).then((s) => s.split("\n").map((x) => x.trim()).filter(Boolean), () => []);
      if (names[0]) remote = await urlOf(names[0]);
    }
    const url = remote ? commitWebUrl(remote, c.sha) : null;
    if (!url) {
      void vscode.window.showInformationMessage(`Polylog: ${c.repo.name} has no remote with a web page for this commit.`);
      return undefined;
    }
    // The integration suite checks the URL without launching a browser.
    if (process.env.POLYLOG_ITEST !== "1") await vscode.env.openExternal(vscode.Uri.parse(url, true));
    return url;
  }

  /** Sets the repo filter from the host (a right-click): the webview gets it with init. */
  private async setRepoFilter(repoIds: string[] | null): Promise<void> {
    const key = (ids: string[] | null) => (ids === null ? null : ids.join("\0"));
    if (key(repoIds) === key(this.filter.repoIds)) return;
    // A filter the user cannot see is a trap: picking repositories shows the pane.
    if (repoIds !== null && this.context.globalState.get<boolean>(HIDE_REPOS_KEY, false)) {
      await this.context.globalState.update(HIDE_REPOS_KEY, false);
      await vscode.commands.executeCommand("setContext", HIDE_REPOS_KEY, false);
    }
    this.filter = { ...this.filter, repoIds };
    this.persistFilter();
    this.postInit();
    this.reloadSoon.cancel();
    await this.reload();
  }

  /** Right-click → Show Only: this repository's commits alone. */
  async repoShowOnly(arg: unknown): Promise<void> {
    const repo = this.contextRepo(arg);
    if (repo) await this.setRepoFilter([repo.id]);
  }

  /** Right-click → Hide from the Log: untick this repository (the others stay as they are). */
  async repoHide(arg: unknown): Promise<void> {
    const repo = this.contextRepo(arg);
    if (!repo) return;
    const shown = this.filter.repoIds ?? this.repos.map((r) => r.id);
    await this.setRepoFilter(shown.filter((id) => id !== repo.id));
  }

  /** Right-click → Show All Repositories. */
  async repoShowAll(): Promise<void> {
    if (this.filter.repoIds !== null) await this.setRepoFilter(null);
  }

  async repoCopyPath(arg: unknown): Promise<void> {
    const repo = this.contextRepo(arg);
    if (repo) await vscode.env.clipboard.writeText(repo.root);
  }

  async repoOpenFolder(arg: unknown): Promise<void> {
    const repo = this.contextRepo(arg);
    if (repo) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(repo.root), { forceNewWindow: true });
  }

  /**
   * Right-click → Exclude from Polylog: adds the repository's exact path to polylog.excludeRepos
   * (so a repo elsewhere with the same name stays), with an Undo. It goes where the setting
   * already applies from: settings arrays do not merge across scopes, so writing to another
   * would drop the user's own entries. With none yet, the user settings: an absolute path
   * belongs to this machine, not in a workspace file that may sit inside a repository.
   */
  async repoExclude(arg: unknown): Promise<void> {
    const repo = this.contextRepo(arg);
    if (!repo) return;
    const inspected = vscode.workspace.getConfiguration("polylog").inspect<string[]>("excludeRepos");
    const target = inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const previous = target === vscode.ConfigurationTarget.Workspace ? inspected?.workspaceValue : inspected?.globalValue;
    const pattern = repo.root.replace(/\\/g, "/");
    const next = addExclusion(previous, pattern);
    if (!next) return;
    // The repo leaves the filter too, or a filter of only it would match nothing.
    const ids = this.filter.repoIds;
    if (ids?.includes(repo.id)) {
      const rest = ids.filter((id) => id !== repo.id);
      this.filter = { ...this.filter, repoIds: rest.length > 0 ? rest : null };
      this.persistFilter();
    }
    // The configuration listener lists the repositories again (reposSettingChanged).
    await vscode.workspace.getConfiguration("polylog").update("excludeRepos", next, target);
    void vscode.window.showInformationMessage(`Polylog: ${repo.name} is excluded (polylog.excludeRepos).`, "Undo").then(async (pick) => {
      if (pick !== "Undo") return;
      const now = vscode.workspace.getConfiguration("polylog").inspect<string[]>("excludeRepos");
      const current = (target === vscode.ConfigurationTarget.Workspace ? now?.workspaceValue : now?.globalValue) ?? [];
      await vscode.workspace.getConfiguration("polylog").update("excludeRepos", undoExclusion(current, pattern, previous), target);
    });
  }

  private async reload(): Promise<void> {
    this.stats.reloads++;
    this.query.abort();
    const ctl = (this.query = new AbortController());
    const s = this.settings();
    this.post({ type: "loading" });
    const t = Date.now();
    // Uncommitted changes are read alongside the page, only while they are shown.
    const working = this.readUncommitted();
    if (this.review) {
      // Review Uncommitted lists repositories with changes, not commits: no git log at all.
      await working;
      if (ctl.signal.aborted) return;
      this.rows = [];
      this.failures = [];
      this.done = true;
      this.queryState = null;
      this.showReviewTree();
      this.postInit();
      this.post({ type: "page", rows: this.shownRows(), append: false, failures: [], done: true, now: nowSec() });
      return;
    }
    try {
      // Me needs each repository's user.email, or the first page is empty and read twice.
      if (this.filter.mine && this.meFor !== this.repos.map((r) => r.id).join("\0")) {
        if (await this.readMe()) this.postInit();
        if (ctl.signal.aborted) return;
      }
      // The commits do not wait for the uncommitted read: its rows follow as they land.
      const page = await fetchPage({
        repos: this.repos, filter: this.filter, pageSize: s.pageSize, concurrency: s.maxConcurrency,
        now: nowSec(), prev: null, run: this.run, signal: ctl.signal, me: this.meByRepo, history: this.history,
      });
      if (ctl.signal.aborted) return;
      this.rows = page.rows;
      this.failures = page.failures;
      this.done = page.done;
      this.queryState = page.state;
      this.branchUse = page.branchUse;
      if (!this.stats.firstRowsAt && page.rows.length > 0) this.stats.firstRowsAt = Date.now();
      this.stats.fetchMs = Date.now() - t;
      this.startBackgroundReads();
      this.clearTreeIfGone();
      this.post({ type: "page", rows: this.shownRows(), append: false, failures: page.failures, done: page.done, now: nowSec(), branchUse: page.branchUse });
    } catch (e) {
      if (!isAbortError(e)) void vscode.window.showErrorMessage(`Polylog could not read the log: ${messageOf(e)}`);
    }
  }

  private async loadMore(): Promise<void> {
    if (this.loadingMore || this.done || !this.queryState) return;
    this.loadingMore = true;
    const ctl = this.query; // a filter change aborts this too
    const s = this.settings();
    try {
      const page = await fetchPage({
        repos: this.repos, filter: this.filter, pageSize: s.pageSize, concurrency: s.maxConcurrency,
        now: nowSec(), prev: this.queryState, run: this.run, signal: ctl.signal, me: this.meByRepo, history: this.history,
      });
      if (ctl.signal.aborted) return;
      this.rows = this.rows.concat(page.rows);
      this.failures = this.failures.concat(page.failures);
      this.done = page.done;
      this.queryState = page.state;
      this.post({ type: "page", rows: page.rows, append: true, failures: page.failures, done: page.done, now: nowSec(), branchUse: page.branchUse });
    } catch (e) {
      if (!isAbortError(e)) void vscode.window.showErrorMessage(`Polylog could not load more commits: ${messageOf(e)}`);
    } finally {
      this.loadingMore = false;
    }
  }

  snapshot(): LogSnapshot {
    return {
      repos: this.repos, filter: this.filter, rows: this.shownRows(), failures: this.failures, done: this.done,
      readyCount: this.readyCount, me: this.repos.flatMap((r) => this.meByRepo.get(r.id) ?? []), history: this.history, review: this.review, persistedFilter: this.context.workspaceState.get<FilterState>(FILTER_KEY), branches: this.branches, authors: this.authors, branchUse: this.branchUse, changes: this.deps.changes.snapshot(), changesVisible: this.deps.changes.visible,
      layout: this.layout(),
      stats: {
        msToFirstRows: this.stats.firstRowsAt ? this.stats.firstRowsAt - this.stats.createdAt : null,
        reloads: this.stats.reloads, discoveries: this.stats.discoveries, spawns: this.stats.spawns,
        discoveryMs: this.stats.discoveryMs, fetchMs: this.stats.fetchMs,
        msToResolve: this.stats.resolvedAt - this.stats.createdAt, msToReady: this.stats.readyAt - this.stats.createdAt,
      },
      spawnLog: [...this.spawnLog],
      sync: Object.fromEntries(this.sync),
      reported: this.repos.filter((r) => this.deps.discovery.reportsChanges(r.root)).map((r) => r.root),
      posts: structuredClone(this.posts),
    };
  }

  private findCommit(repoId: string, sha: string): { commit: Commit; repo: Repo } | undefined {
    if (!isSha(sha)) return undefined;
    const repo = this.repos.find((r) => r.id === repoId);
    const commit = this.shownRows().find((c) => c.repoId === repoId && c.sha === sha);
    return repo && commit ? { commit, repo } : undefined;
  }

  private async showDetail(repoId: string, sha: string): Promise<void> {
    // Validate first: a select that is not a listed commit must not kill the
    // detail already loading for the one that is.
    const found = this.findCommit(repoId, sha);
    if (!found) return;
    if (sha === UNCOMMITTED && this.review) {
      // The tree shows the repository clicked, not every one.
      this.reviewRepo = repoId;
      this.showReviewTree();
      return;
    }
    if (sha === UNCOMMITTED) {
      // Not a commit: its files come from git status, already read.
      this.detail.abort();
      const { commit, repo } = found;
      this.deps.changes.set({ commit, repoRoot: repo.root, repoName: repo.name, status: "ready", message: "", files: this.uncommitted.get(repoId)?.files ?? [] });
      return;
    }
    this.detail.abort();
    const ctl = (this.detail = new AbortController());
    const { commit, repo } = found;
    const key = commitKey(commit);
    if (this.openWhenLoaded !== key) this.openWhenLoaded = null;
    const base = { commit, repoRoot: repo.root, repoName: repo.name, files: [], message: "", focusPath: commit.file?.path };
    // File history: the diff follows the selection, in one preview tab, keeping focus in the Log.
    if (this.history && commit.file) void this.openHistoryDiff(commit);
    this.deps.changes.set({ ...base, status: "loading" });
    try {
      const { files, message } = parseShow(await this.run(repo.root, showArgs(sha), ctl.signal));
      if (ctl.signal.aborted) return; // a newer selection owns the tree now
      this.deps.changes.set({ ...base, status: "ready", files, message });
      if (this.openWhenLoaded === key) {
        this.openWhenLoaded = null;
        await this.openFirstOf(commit);
      }
    } catch (e) {
      if (!isAbortError(e) && !ctl.signal.aborted) this.deps.changes.set({ ...base, status: "error", error: messageOf(e) });
    }
  }

  /** A filter or refresh removed the tree's commit from the list: show nothing rather than a stale commit. */
  private clearTreeIfGone(): void {
    const current = this.deps.changes.current();
    if (!current || this.review) return;
    const key = commitKey(current.commit);
    if (this.shownRows().some((c) => commitKey(c) === key)) return;
    this.detail.abort();
    this.openWhenLoaded = null;
    this.deps.changes.set(null);
  }

  private openHistoryDiff(commit: Commit, preserveFocus = true): Promise<void> {
    // Overlapping swaps (holding ↓ with preview editors off) closed the tab a later
    // step had just activated: its diff was still open, so VS Code reused it.
    const step = ++this.historyStep;
    const run = () => (step === this.historyStep ? this.swapHistoryDiff(commit, preserveFocus) : undefined);
    this.historySteps = this.historySteps.then(run, run);
    return this.historySteps;
  }

  private async swapHistoryDiff(commit: Commit, preserveFocus: boolean): Promise<void> {
    if (!this.history) return; // queued before the user closed File History
    const f = commit.file!;
    const opened = await this.openDiff({ repoId: commit.repoId, sha: commit.sha, parent: commit.parents[0] ?? null, path: f.path, oldPath: f.oldPath, status: f.status }, preserveFocus);
    // Stepping through a history reuses one tab. VS Code's preview tab does that
    // unless the user turned preview editors off; then close the previous one.
    const previous = this.historyTab;
    this.historyTab = opened;
    if (!previous || previous === opened || vscode.workspace.getConfiguration("workbench.editor").get("enablePreview", true)) return;
    const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs)
      .find((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === previous && !t.isDirty && !t.isPinned);
    if (tab) await vscode.window.tabGroups.close(tab, true);
  }

  private async openFirst(repoId: string, sha: string): Promise<void> {
    const found = this.findCommit(repoId, sha);
    if (!found) return;
    if (this.history && found.commit.file) return this.openHistoryDiff(found.commit, false);
    const current = this.deps.changes.current();
    if (current && commitKey(current.commit) === commitKey(found.commit) && current.status === "ready") {
      await this.openFirstOf(found.commit);
      return;
    }
    this.openWhenLoaded = commitKey(found.commit);
    if (!current || commitKey(current.commit) !== commitKey(found.commit)) await this.showDetail(repoId, sha);
  }

  private async openFirstOf(commit: Commit): Promise<void> {
    const f = firstOpenable(this.deps.changes.current()?.files ?? []);
    if (!f) return;
    await this.openDiff({ repoId: commit.repoId, sha: commit.sha, parent: commit.parents[0] ?? null, path: f.path, oldPath: f.oldPath, status: f.status });
  }

  /** Opens the diff; returns its modified-side URI (as a string), or undefined when refused. */
  async openDiff(a: OpenDiffArgs, preserveFocus = false): Promise<string | undefined> {
    const repo = this.repos.find((r) => r.id === a?.repoId);
    // Refs come from the webview or a command argument: validate before they reach git.
    if (!repo || !isSha(a.sha) || !(a.parent === null || isSha(a.parent)) || typeof a.path !== "string") return;
    if (a.sha === UNCOMMITTED) return this.openWorkingDiff(repo, a, preserveFocus);
    const status = typeof a.status === "string" ? a.status : undefined;
    const { before, after } = diffSides(repo.root, { sha: a.sha, parents: a.parent ? [a.parent] : [] }, { path: a.path, oldPath: a.oldPath, status });
    const title = `${path.posix.basename(a.path)} (${a.sha.slice(0, 7)}) — ${repo.name}`;
    // A panel view is not an editor group, so this always opens in the editor area above.
    const modified = toUri(after);
    await vscode.commands.executeCommand("vscode.diff", toUri(before), modified, title, { preview: true, preserveFocus });
    return modified.toString();
  }

  /**
   * An uncommitted file: the last commit on the left, the real file on the right (so it can
   * be edited while reviewing). New files have an empty left side, deleted files an empty right.
   */
  private async openWorkingDiff(repo: Repo, a: OpenDiffArgs, preserveFocus: boolean): Promise<string | undefined> {
    const file = this.uncommitted.get(repo.id)?.files.find((f) => f.path === a.path);
    if (!file) return undefined;
    const isNew = file.status === "A" || file.untracked === true || !a.parent;
    const before = toUri({ root: repo.root, ref: isNew ? null : a.parent, path: file.oldPath ?? file.path });
    const after = file.status === "D" ? toUri({ root: repo.root, ref: null, path: file.path }) : vscode.Uri.file(path.join(repo.root, ...file.path.split("/")));
    const title = `${path.posix.basename(file.path)} (uncommitted) — ${repo.name}`;
    await vscode.commands.executeCommand("vscode.diff", before, after, title, { preview: true, preserveFocus });
    return after.toString();
  }

  /** The toggle as last set from the toolbar, before the setting is written back. */
  private uncommittedPref: boolean | undefined;
  /** The toggle the rows were last read (or dropped) for. */
  private uncommittedApplied = vscode.workspace.getConfiguration("polylog").get<boolean>("showUncommitted", false) === true;

  /** The "Show Uncommitted Changes" toggle (polylog.showUncommitted). */
  private uncommittedOn(): boolean {
    return this.uncommittedPref ?? vscode.workspace.getConfiguration("polylog").get<boolean>("showUncommitted", false) === true;
  }

  /**
   * The toolbar toggle: acts at once, then saves the setting. Waiting for settings.json to
   * be written and the change to come back made the toggle feel slow.
   */
  async setUncommittedOn(on: boolean): Promise<void> {
    if (on === this.uncommittedOn()) return;
    this.uncommittedPref = on;
    void vscode.commands.executeCommand("setContext", "polylog.showUncommitted", on);
    const saved = vscode.workspace.getConfiguration("polylog").update("showUncommitted", on, vscode.ConfigurationTarget.Global);
    await this.uncommittedToggled();
    await saved;
  }

  /** The setting changed (Settings UI, settings.json, or our own write coming back). */
  async uncommittedSettingChanged(): Promise<void> {
    const setting = vscode.workspace.getConfiguration("polylog").get<boolean>("showUncommitted", false) === true;
    void vscode.commands.executeCommand("setContext", "polylog.showUncommitted", setting);
    this.uncommittedPref = undefined; // the setting is the source again
    // Our own write coming back, after the toolbar already acted, needs nothing.
    if (setting === this.uncommittedApplied) return;
    await this.uncommittedToggled();
  }

  /**
   * Whether the pinned rows show: the toggle is on, and no filter they cannot match is set
   * (uncommitted work has no message, author or branch; File History is about one file).
   */
  private uncommittedShown(): boolean {
    if (this.review) return true;
    const f = this.filter;
    const filtered = f.text.trim() !== "" || f.author.trim() !== "" || (f.authors ?? []).length > 0 || f.mine || f.branch !== "";
    return this.uncommittedOn() && this.history === null && !filtered;
  }

  /** The rows the Log shows: each repository's uncommitted changes pinned above the commits. */
  private shownRows(): Commit[] {
    if (!this.uncommittedShown()) return this.rows;
    const pinned = this.pinnedRows();
    return this.review ? pinned : [...pinned, ...this.rows];
  }

  /** One row per repository with uncommitted changes, in repository order. */
  private pinnedRows(): Commit[] {
    if (!this.uncommittedShown()) return [];
    const now = nowSec();
    const pinned: Commit[] = [];
    for (const repo of this.repos) {
      const w = this.uncommitted.get(repo.id);
      if (!w || w.files.length === 0) continue;
      pinned.push({ repoId: repo.id, sha: UNCOMMITTED, time: now, author: "", email: "", subject: "Uncommitted changes", parents: w.head ? [w.head] : [], uncommitted: w.files.length });
    }
    return pinned;
  }

  /** Opens Review Uncommitted: every repository's uncommitted files in one tree. */
  async reviewUncommitted(): Promise<void> {
    if (this.repos.length === 0) await this.loadRepos();
    await vscode.commands.executeCommand(`${LogView.id}.focus`);
    if (this.history) this.leaveHistory();
    this.review = true;
    this.reviewRepo = undefined;
    // The last look before a commit: read every repository fresh, not from what events kept.
    this.forgetUncommittedRead();
    this.postInit();
    await this.reload();
  }

  private async leaveReview(): Promise<void> {
    if (!this.review) return;
    this.review = false;
    this.deps.changes.set(null);
    this.postInit();
    await this.reload();
  }

  /** The review tree: the clicked repository's uncommitted files (every repository's until a click). */
  private showReviewTree(): void {
    const rows = this.shownRows();
    const clicked = rows.filter((c) => c.repoId === this.reviewRepo);
    const pinned = clicked.length > 0 ? clicked : rows;
    const groups = pinned.flatMap((commit) => {
      const repo = this.repos.find((r) => r.id === commit.repoId);
      return repo ? [{ commit, repoRoot: repo.root, repoName: repo.name, files: this.uncommitted.get(repo.id)?.files ?? [] }] : [];
    });
    const first = groups[0];
    const placeholder: Commit = { repoId: "", sha: UNCOMMITTED, time: nowSec(), author: "", email: "", subject: "Uncommitted changes", parents: [] };
    this.deps.changes.set({ commit: first?.commit ?? placeholder, repoRoot: first?.repoRoot ?? "", repoName: first?.repoName ?? "", status: "ready", message: "", files: [], groups });
  }

  /** How much there is to review, for the mode bar. */
  private reviewSummary(): { files: number; repos: number } {
    let files = 0;
    let repos = 0;
    for (const w of this.uncommitted.values()) {
      if (w.files.length === 0) continue;
      files += w.files.length;
      repos++;
    }
    return { files, repos };
  }

  /**
   * Reads the selected repositories' uncommitted changes (git status + numstat, under the Path
   * filter), or forgets them when they are not shown. `only`: just these repositories (their
   * working tree changed). Each result is merged in as it lands, and the Log is told only when
   * a repository's changes really differ from what it shows.
   */
  private async readUncommitted(only?: ReadonlySet<string>): Promise<void> {
    if (!this.uncommittedShown()) {
      this.uncommittedRead.abort();
      this.repoReads.abort();
      if (this.hasPinned()) this.publishUncommittedSoon();
      this.uncommitted = new Map();
      this.uncommittedSpec = undefined;
      this.uncommittedDone = this.uncommittedInFlight = undefined;
      return;
    }
    const path = this.filter.path === undefined ? undefined : normalizePath(this.filter.path);
    const specs = path ? [pathspecOf(path)] : [];
    const spec = specs.join("\0");
    let repos = selectRepos(this.filter, this.repos);
    let ctl: AbortController;
    if (only) {
      // Under another Path filter, a read of every repository is already on its way.
      if (spec !== this.uncommittedSpec) return;
      repos = repos.filter((r) => only.has(r.id));
      ctl = this.repoReads;
    } else {
      const readKey = `${spec}\n${repos.map((r) => r.id).join("\0")}`;
      if (readKey === this.uncommittedInFlight && !this.uncommittedRead.signal.aborted && this.uncommittedReading) return this.uncommittedReading;
      if (readKey === this.uncommittedDone) {
        // Kept current by VS Code's Git and saves, except where it reports nothing: read those.
        const unreported = repos.filter((r) => !this.deps.discovery.reportsChanges(r.root));
        if (unreported.length > 0) await this.readUncommitted(new Set(unreported.map((r) => r.id)));
        return;
      }
      this.uncommittedDone = undefined;
      this.uncommittedInFlight = readKey;
      this.uncommittedRead.abort();
      this.repoReads.abort();
      this.repoReads = new AbortController();
      ctl = this.uncommittedRead = new AbortController();
      // Until its new result lands, each repository keeps its last one (no flicker), unless the
      // Path filter changed: then the old rows answer another question.
      const keep = spec === this.uncommittedSpec ? new Set(repos.map((r) => r.id)) : new Set<string>();
      for (const [id, w] of this.uncommitted) {
        if (keep.has(id)) continue;
        this.uncommitted.delete(id);
        if (w.files.length > 0) this.publishUncommittedSoon();
      }
      this.uncommittedSpec = spec;
    }
    const reading = runPool(repos, this.settings().maxConcurrency, async (r, signal) => {
      const seq = ++this.uncommittedSeq;
      // One call for a clean repo: --branch carries the last commit's id too.
      const out = await this.run(r.root, statusArgs(specs), signal);
      const head = headOf(out);
      const status = parseStatus(out);
      const files = status.length === 0 ? [] : uncommittedFiles(status, parseNumstat(await this.run(r.root, numstatArgs(head, specs), signal)));
      if (ctl.signal.aborted) return;
      const old = this.uncommitted.get(r.id);
      if (old && old.seq > seq) return;
      this.uncommitted.set(r.id, { head, files, seq });
      // Show each repository as soon as it is read, rather than after the slowest one.
      if (!sameWorking(old, { head, files })) this.publishUncommittedSoon();
    }, ctl.signal);
    if (only) {
      await reading;
      return;
    }
    const done = reading.then((settled) => {
      if (this.uncommittedRead !== ctl) return;
      this.uncommittedReading = undefined;
      // Done only if every repository answered: one that failed is read again next time.
      if (!ctl.signal.aborted && settled.every((s) => s.status === "fulfilled")) this.uncommittedDone = this.uncommittedInFlight;
      this.uncommittedInFlight = undefined;
    });
    this.uncommittedReading = done;
    await done;
  }

  /** Refresh, or a new git binary: the next read of every repository really reads. */
  private forgetUncommittedRead(): void {
    this.uncommittedDone = this.uncommittedInFlight = undefined;
    this.uncommittedReading = undefined;
  }

  private hasPinned(): boolean {
    for (const w of this.uncommitted.values()) if (w.files.length > 0) return true;
    return false;
  }

  private publishTimer: ReturnType<typeof setTimeout> | undefined;

  /** Coalesces progressive updates: at most one repaint every 80 ms while repos come in. */
  private publishUncommittedSoon(): void {
    if (this.publishTimer) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      this.publishUncommitted();
    }, 80);
  }

  /**
   * Posts the pinned rows (and the review tree, or the selected uncommitted row's files) as they
   * are now. Only the pinned rows: the webview keeps its commits, however many are loaded.
   */
  private publishUncommitted(): void {
    this.post({ type: "pinned", rows: this.pinnedRows(), review: this.review ? this.reviewSummary() : null });
    if (this.review) {
      this.showReviewTree();
      return;
    }
    const current = this.deps.changes.current();
    if (current?.commit.sha === UNCOMMITTED) {
      const still = this.shownRows().find((c) => c.repoId === current.commit.repoId && c.sha === UNCOMMITTED);
      if (still) this.deps.changes.set({ ...current, commit: still, files: this.uncommitted.get(still.repoId)?.files ?? [] });
      else this.deps.changes.set(null);
    }
  }

  /** The toggle changed: read (or drop) the uncommitted changes, showing repos as they come. */
  async uncommittedToggled(): Promise<void> {
    this.uncommittedApplied = this.uncommittedOn();
    if (!this.uncommittedShown()) this.clearTreeIfGone();
    await this.readUncommitted();
  }

  /**
   * A file was saved, or VS Code's Git reported a new state for a repository: if uncommitted
   * changes are shown, read that repository again (after a burst settles), and nothing else.
   */
  workingTreeChanged(fsPath: string): void {
    if (!this.uncommittedShown()) return;
    const repo = this.innermost(fsPath)?.r;
    if (!repo) return; // outside every repository of the workspace
    this.touched.add(repo.id);
    this.touchedSoon();
  }

  /** Reads these repositories' uncommitted changes again; the Log hears only of real changes. */
  async uncommittedChanged(ids: ReadonlySet<string>): Promise<void> {
    if (!this.uncommittedShown()) return;
    await this.readUncommitted(ids);
  }

  private post(m: HostMessage): void {
    if (MEASURE_POSTS) {
      const p = (this.posts[m.type] ??= { count: 0, bytes: 0 });
      p.count++;
      p.bytes += JSON.stringify(m).length;
    }
    void this.webviewView?.webview.postMessage(m);
  }

  dispose(): void {
    this.query.abort();
    this.detail.abort();
    this.uncommittedRead.abort();
    this.repoReads.abort();
    this.fetchCtl.abort();
    this.touchedSoon.cancel();
    this.syncSoon.cancel();
    clearTimeout(this.publishTimer);
    this.reloadSoon.cancel();
    this.reposChangedSoon.cancel();
    for (const d of this.disposables) d.dispose();
    this.visibilityChanged.dispose();
  }
}
