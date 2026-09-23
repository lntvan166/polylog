import { randomBytes } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { firstOpenable } from "./changesModel";
import type { ChangesSnapshot, ChangesTree, OpenDiffArgs } from "./changesTree";
import { diffSides, parseShow, showArgs } from "./commitDetail";
import { debounce } from "./debounce";
import { DEFAULT_FILTER, sameExceptText, sanitizeFilter, type FilterState } from "./filterModel";
import { fetchPage, type BranchUse, type QueryState, type RunGit } from "./logQuery";
import { isAbortError, runPool } from "./pool";
import type { BranchName, HostMessage, Layout, WebviewMessage } from "./protocol";
import type { RepoDiscovery } from "./repoDiscovery";
import { decodeRevision, encodeRevision, SCHEME, type RevisionRef } from "./revisionUri";
import { branchSuggestions } from "./repos";
import { readSettings } from "./settings";
import { commitKey, isSha, type Commit, type Repo, type RepoFailure } from "./types";
import { renderHtml } from "./webview/html";

const FILTER_KEY = "polylog.filter";
/** globalState: true when the user turned Group by Repository off. */
export const HIDE_REPOS_KEY = "polylog.hideRepos";
/** globalState: the Repositories pane width the user dragged to. */
const PANE_WIDTH_KEY = "polylog.repoPaneWidth";
const DEFAULT_PANE_WIDTH = 190;
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
  /** What a window reload would restore. */
  persistedFilter: FilterState | undefined;
  branches: BranchName[];
  branchUse: BranchUse | undefined;
  changes: ChangesSnapshot;
  layout: Layout;
  stats: { msToFirstRows: number | null; reloads: number; discoveries: number; spawns: number; discoveryMs: number; fetchMs: number; msToResolve: number; msToReady: number };
}

const nowSec = () => Math.floor(Date.now() / 1000);
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
  private dateBeforeHistory: Pick<FilterState, "date" | "from" | "to"> | null = null;
  /** Branch names across the workspace, for the Branch box's suggestions. Read in the background. */
  private branches: BranchName[] = [];
  private branchUse: BranchUse | undefined;
  /** The repo set the background reads last ran for. */
  private backgroundFor: string | undefined;
  /** Enter arrived before the selected commit's files: open the first one when they land. */
  private openWhenLoaded: string | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly reloadSoon = debounce(() => void this.reload(), SEARCH_DEBOUNCE_MS);
  // The git extension opens repositories in bursts at startup; coalesce them.
  private readonly reposChangedSoon = debounce(() => void this.refreshRepos(), SEARCH_DEBOUNCE_MS);

  /** Startup and load cost, for the perf harness and the integration suite. */
  private readonly stats = { createdAt: Date.now(), firstRowsAt: 0, reloads: 0, discoveries: 0, spawns: 0, discoveryMs: 0, fetchMs: 0, resolvedAt: 0, readyAt: 0 };
  private readonly run: RunGit;
  private firstLoad: Promise<void> | undefined;

  constructor(private readonly context: vscode.ExtensionContext, private readonly deps: LogDeps) {
    this.run = (cwd, args, signal) => {
      this.stats.spawns++;
      return deps.run(cwd, args, signal);
    };
    this.filter = sanitizeFilter(context.workspaceState.get(FILTER_KEY) ?? DEFAULT_FILTER);
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
    this.disposables.push(
      view.webview.onDidReceiveMessage((m: WebviewMessage) => void this.onMessage(m)),
      view.onDidDispose(() => {
        if (this.webviewView === view) this.webviewView = undefined;
      }),
    );
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
        if (this.queryState === null) await this.reload();
        else this.post({ type: "page", rows: this.rows, append: false, failures: this.failures, done: this.done, now: nowSec(), branchUse: this.branchUse });
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
    this.post({ type: "init", repos: this.repos, filter: this.filter, hasMe: this.meByRepo.size > 0, layout: this.layout(), history, branches: this.branches });
  }

  /**
   * "Polylog: File History" from the Explorer, an editor, a diff or the Changes
   * tree. Accepts a file: URI, a polylog: revision URI, a Changes file node, or
   * nothing (the active editor).
   */
  async fileHistory(arg?: unknown): Promise<void> {
    if (this.repos.length === 0) await this.loadRepos();
    let target: { repoId: string; path: string } | undefined;
    const current = this.deps.changes.current();
    if (arg && typeof arg === "object" && (arg as { kind?: unknown }).kind === "file" && current) {
      target = { repoId: current.commit.repoId, path: (arg as { path: string }).path };
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

  /** The workspace repository containing a file (innermost first), and its repo-relative path. */
  private locate(fsPath: string): { repoId: string; path: string } | undefined {
    const inside = this.repos
      .map((r) => ({ r, rel: path.relative(r.root, fsPath) }))
      .filter((x) => x.rel !== "" && !x.rel.startsWith("..") && !path.isAbsolute(x.rel))
      .sort((a, b) => a.rel.length - b.rel.length)[0];
    return inside ? { repoId: inside.r.id, path: inside.rel.split(path.sep).join("/") } : undefined;
  }

  /** Save the filter; while File History forces all time, save the range the user will come back to. */
  private persistFilter(): void {
    const saved = this.history && this.dateBeforeHistory ? { ...this.filter, ...this.dateBeforeHistory } : this.filter;
    void this.context.workspaceState.update(FILTER_KEY, saved);
  }

  /** Leave File History without reloading: restore the date range. */
  private leaveHistory(): void {
    if (this.dateBeforeHistory) this.filter = { ...this.filter, ...this.dateBeforeHistory };
    this.dateBeforeHistory = null;
    this.history = null;
    // The next File History is a new session: its first step must not close this one's diff.
    this.historyTab = undefined;
    this.persistFilter();
  }

  /**
   * File history shows all time; closing it restores the date range the user
   * had before (even if they changed it while in history).
   */
  private async setHistory(history: { repoId: string; path: string } | null): Promise<void> {
    if (history && !this.history) {
      const { date, from, to } = this.filter;
      this.dateBeforeHistory = { date, from, to };
      this.filter = { ...this.filter, date: "all", from: undefined, to: undefined };
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
    void this.loadBranches();
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
    this.postInit();
  }

  /** Each repo's user.email, in the background so it never delays the first paint. */
  private async loadMe(): Promise<void> {
    const repos = [...this.repos];
    const settled = await runPool(repos, this.settings().maxConcurrency,
      (r, signal) => this.run(r.root, ["config", "user.email"], signal), new AbortController().signal);
    const me = new Map<string, string>();
    settled.forEach((s, i) => {
      if (s.status === "fulfilled" && s.value.trim()) me.set(repos[i].id, s.value.trim());
    });
    const changed = [...me].join() !== [...this.meByRepo].join();
    this.meByRepo = me;
    if (!changed) return;
    this.postInit();
    if (this.filter.mine) await this.reload();
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
  }

  private async reload(): Promise<void> {
    this.stats.reloads++;
    this.query.abort();
    const ctl = (this.query = new AbortController());
    const s = this.settings();
    this.post({ type: "loading" });
    const t = Date.now();
    try {
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
      this.post({ type: "page", rows: page.rows, append: false, failures: page.failures, done: page.done, now: nowSec(), branchUse: page.branchUse });
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
      repos: this.repos, filter: this.filter, rows: this.rows, failures: this.failures, done: this.done,
      readyCount: this.readyCount, me: this.repos.flatMap((r) => this.meByRepo.get(r.id) ?? []), history: this.history, persistedFilter: this.context.workspaceState.get<FilterState>(FILTER_KEY), branches: this.branches, branchUse: this.branchUse, changes: this.deps.changes.snapshot(),
      layout: this.layout(),
      stats: {
        msToFirstRows: this.stats.firstRowsAt ? this.stats.firstRowsAt - this.stats.createdAt : null,
        reloads: this.stats.reloads, discoveries: this.stats.discoveries, spawns: this.stats.spawns,
        discoveryMs: this.stats.discoveryMs, fetchMs: this.stats.fetchMs,
        msToResolve: this.stats.resolvedAt - this.stats.createdAt, msToReady: this.stats.readyAt - this.stats.createdAt,
      },
    };
  }

  private findCommit(repoId: string, sha: string): { commit: Commit; repo: Repo } | undefined {
    if (!isSha(sha)) return undefined;
    const repo = this.repos.find((r) => r.id === repoId);
    const commit = this.rows.find((c) => c.repoId === repoId && c.sha === sha);
    return repo && commit ? { commit, repo } : undefined;
  }

  private async showDetail(repoId: string, sha: string): Promise<void> {
    // Validate first: a select that is not a listed commit must not kill the
    // detail already loading for the one that is.
    const found = this.findCommit(repoId, sha);
    if (!found) return;
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
    if (!current) return;
    const key = commitKey(current.commit);
    if (this.rows.some((c) => commitKey(c) === key)) return;
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
    const opened = await this.openDiff({ repoId: commit.repoId, sha: commit.sha, parent: commit.parents[0] ?? null, path: f.path, oldPath: f.oldPath }, preserveFocus);
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
    await this.openDiff({ repoId: commit.repoId, sha: commit.sha, parent: commit.parents[0] ?? null, path: f.path, oldPath: f.oldPath });
  }

  /** Opens the diff; returns its modified-side URI (as a string), or undefined when refused. */
  async openDiff(a: OpenDiffArgs, preserveFocus = false): Promise<string | undefined> {
    const repo = this.repos.find((r) => r.id === a?.repoId);
    // Refs come from the webview or a command argument: validate before they reach git.
    if (!repo || !isSha(a.sha) || !(a.parent === null || isSha(a.parent)) || typeof a.path !== "string") return;
    const { before, after } = diffSides(repo.root, { sha: a.sha, parents: a.parent ? [a.parent] : [] }, a);
    const title = `${path.posix.basename(a.path)} (${a.sha.slice(0, 7)}) — ${repo.name}`;
    // A panel view is not an editor group, so this always opens in the editor area above.
    const modified = toUri(after);
    await vscode.commands.executeCommand("vscode.diff", toUri(before), modified, title, { preview: true, preserveFocus });
    return modified.toString();
  }

  private post(m: HostMessage): void {
    void this.webviewView?.webview.postMessage(m);
  }

  dispose(): void {
    this.query.abort();
    this.detail.abort();
    this.reloadSoon.cancel();
    this.reposChangedSoon.cancel();
    for (const d of this.disposables) d.dispose();
  }
}
