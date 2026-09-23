import { randomBytes } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { firstOpenable } from "./changesModel";
import type { ChangesSnapshot, ChangesTree, OpenDiffArgs } from "./changesTree";
import { diffSides, parseShow, showArgs } from "./commitDetail";
import { debounce } from "./debounce";
import { DEFAULT_FILTER, sameExceptText, sanitizeFilter, type FilterState } from "./filterModel";
import { fetchPage, type QueryState, type RunGit } from "./logQuery";
import { isAbortError } from "./pool";
import type { HostMessage, Layout, WebviewMessage } from "./protocol";
import type { RepoDiscovery } from "./repoDiscovery";
import { encodeRevision, SCHEME, type RevisionRef } from "./revisionUri";
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
  me: string | undefined;
  changes: ChangesSnapshot;
  layout: Layout;
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
  /** The user's git email (first repository's config), offered as the "Me" author. */
  private me: string | undefined;
  /** Enter arrived before the selected commit's files: open the first one when they land. */
  private openWhenLoaded: string | null = null;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly reloadSoon = debounce(() => void this.reload(), SEARCH_DEBOUNCE_MS);
  // The git extension opens repositories in bursts at startup; coalesce them.
  private readonly reposChangedSoon = debounce(() => void this.refreshRepos(), SEARCH_DEBOUNCE_MS);

  constructor(private readonly context: vscode.ExtensionContext, private readonly deps: LogDeps) {
    this.filter = sanitizeFilter(context.workspaceState.get(FILTER_KEY) ?? DEFAULT_FILTER);
    this.disposables.push(deps.discovery.onDidChange(() => this.reposChangedSoon()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
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
        // Also sent when a hidden webview is re-created: replay what we have.
        await this.loadRepos();
        this.postInit();
        if (this.queryState === null) await this.reload();
        else this.post({ type: "page", rows: this.rows, append: false, failures: this.failures, done: this.done, now: nowSec() });
        return;
      case "filter": {
        const next = sanitizeFilter(m.filter);
        const textOnly = sameExceptText(next, this.filter);
        this.filter = next;
        void this.context.workspaceState.update(FILTER_KEY, next);
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
        await this.refreshRepos();
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
    this.post({ type: "init", repos: this.repos, filter: this.filter, me: this.me, layout: this.layout() });
  }

  /** Group by Repository: show or hide the Repositories pane (Log title-bar toggle). */
  async setGroupByRepo(on: boolean): Promise<void> {
    await this.context.globalState.update(HIDE_REPOS_KEY, !on);
    await vscode.commands.executeCommand("setContext", HIDE_REPOS_KEY, !on);
    this.postInit();
  }

  private async loadRepos(): Promise<void> {
    this.repos = await this.deps.discovery.list(this.settings());
    const first = this.repos[0];
    if (this.me === undefined && first) {
      const email = await this.deps.run(first.root, ["config", "user.email"], new AbortController().signal).then((o) => o.trim(), () => "");
      this.me = email || undefined;
    }
  }

  private async refreshRepos(): Promise<void> {
    await this.loadRepos();
    this.postInit();
    await this.reload();
  }

  private async reload(): Promise<void> {
    this.query.abort();
    const ctl = (this.query = new AbortController());
    const s = this.settings();
    this.post({ type: "loading" });
    try {
      const page = await fetchPage({
        repos: this.repos, filter: this.filter, pageSize: s.pageSize, concurrency: s.maxConcurrency,
        now: nowSec(), prev: null, run: this.deps.run, signal: ctl.signal,
      });
      if (ctl.signal.aborted) return;
      this.rows = page.rows;
      this.failures = page.failures;
      this.done = page.done;
      this.queryState = page.state;
      this.clearTreeIfGone();
      this.post({ type: "page", rows: page.rows, append: false, failures: page.failures, done: page.done, now: nowSec() });
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
        now: nowSec(), prev: this.queryState, run: this.deps.run, signal: ctl.signal,
      });
      if (ctl.signal.aborted) return;
      this.rows = this.rows.concat(page.rows);
      this.failures = this.failures.concat(page.failures);
      this.done = page.done;
      this.queryState = page.state;
      this.post({ type: "page", rows: page.rows, append: true, failures: page.failures, done: page.done, now: nowSec() });
    } catch (e) {
      if (!isAbortError(e)) void vscode.window.showErrorMessage(`Polylog could not load more commits: ${messageOf(e)}`);
    } finally {
      this.loadingMore = false;
    }
  }

  snapshot(): LogSnapshot {
    return {
      repos: this.repos, filter: this.filter, rows: this.rows, failures: this.failures, done: this.done,
      readyCount: this.readyCount, me: this.me, changes: this.deps.changes.snapshot(),
      layout: this.layout(),
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
    const base = { commit, repoRoot: repo.root, repoName: repo.name, files: [], message: "" };
    this.deps.changes.set({ ...base, status: "loading" });
    try {
      const { files, message } = parseShow(await this.deps.run(repo.root, showArgs(sha), ctl.signal));
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

  private async openFirst(repoId: string, sha: string): Promise<void> {
    const found = this.findCommit(repoId, sha);
    if (!found) return;
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

  async openDiff(a: OpenDiffArgs): Promise<void> {
    const repo = this.repos.find((r) => r.id === a?.repoId);
    // Refs come from the webview or a command argument: validate before they reach git.
    if (!repo || !isSha(a.sha) || !(a.parent === null || isSha(a.parent)) || typeof a.path !== "string") return;
    const { before, after } = diffSides(repo.root, { sha: a.sha, parents: a.parent ? [a.parent] : [] }, a);
    const title = `${path.posix.basename(a.path)} (${a.sha.slice(0, 7)}) — ${repo.name}`;
    // A panel view is not an editor group, so this always opens in the editor area above.
    await vscode.commands.executeCommand("vscode.diff", toUri(before), toUri(after), title, { preview: true });
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
