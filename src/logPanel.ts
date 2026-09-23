import { randomBytes } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { diffSides, parseShow, showArgs } from "./commitDetail";
import { debounce } from "./debounce";
import { DEFAULT_FILTER, sameExceptText, sanitizeFilter, type FilterState } from "./filterModel";
import { fetchPage, type QueryState, type RunGit } from "./logQuery";
import { isAbortError } from "./pool";
import type { HostMessage, WebviewMessage } from "./protocol";
import type { RepoDiscovery } from "./repoDiscovery";
import { encodeRevision, SCHEME, type RevisionRef } from "./revisionUri";
import { readSettings } from "./settings";
import { isSha, type Commit, type Repo, type RepoFailure } from "./types";
import { renderHtml } from "./webview/html";

const FILTER_KEY = "polylog.filter";
/** Without it, typing a six-character term launches 408 child processes. */
const SEARCH_DEBOUNCE_MS = 250;

export interface PanelDeps {
  discovery: RepoDiscovery;
  run: RunGit;
}

export interface PanelSnapshot {
  repos: Repo[];
  filter: FilterState;
  rows: Commit[];
  failures: RepoFailure[];
  done: boolean;
  /** How many times the webview (re)loaded; a hidden-then-shown panel must not reload. */
  readyCount: number;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const toUri = (r: RevisionRef) => vscode.Uri.from({ scheme: SCHEME, ...encodeRevision(r) });

export class LogPanel implements vscode.Disposable {
  static current: LogPanel | undefined;

  static show(context: vscode.ExtensionContext, deps: PanelDeps): LogPanel {
    if (LogPanel.current) {
      LogPanel.current.panel.reveal();
      return LogPanel.current;
    }
    const panel = vscode.window.createWebviewPanel("polylog.log", "Polylog", vscode.ViewColumn.Active, {
      enableScripts: true,
      // Opening a file's diff puts the panel in the background. Without this the
      // webview is destroyed and rebuilt, losing selection and scroll on every
      // file opened — the product's core loop.
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "out")],
    });
    LogPanel.current = new LogPanel(panel, context, deps);
    return LogPanel.current;
  }

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
  private readonly disposables: vscode.Disposable[] = [];
  private readonly reloadSoon = debounce(() => void this.reload(), SEARCH_DEBOUNCE_MS);
  // The git extension opens repositories in bursts at startup; coalesce them.
  private readonly reposChangedSoon = debounce(() => void this.refreshRepos(), SEARCH_DEBOUNCE_MS);

  private constructor(private readonly panel: vscode.WebviewPanel, private readonly context: vscode.ExtensionContext, private readonly deps: PanelDeps) {
    this.filter = sanitizeFilter(context.workspaceState.get(FILTER_KEY) ?? DEFAULT_FILTER);
    const webview = panel.webview;
    const out = vscode.Uri.joinPath(context.extensionUri, "out");
    webview.html = renderHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString("hex"),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(out, "webview.js")).toString(),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(out, "webview.css")).toString(),
    });
    this.disposables.push(
      webview.onDidReceiveMessage((m: WebviewMessage) => void this.onMessage(m)),
      deps.discovery.onDidChange(() => this.reposChangedSoon()),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  async onMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case "ready":
        this.readyCount++;
        // Also sent when a hidden webview is re-created: replay what we have.
        await this.loadRepos();
        this.post({ type: "init", repos: this.repos, filter: this.filter });
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
      case "openFile":
        await this.openFile(m);
        return;
      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "scan depth");
        return;
    }
  }

  snapshot(): PanelSnapshot {
    return { repos: this.repos, filter: this.filter, rows: this.rows, failures: this.failures, done: this.done, readyCount: this.readyCount };
  }

  private settings() {
    const config = vscode.workspace.getConfiguration("polylog");
    return readSettings((key) => config.get(key));
  }

  private async loadRepos(): Promise<void> {
    this.repos = await this.deps.discovery.list(this.settings());
  }

  private async refreshRepos(): Promise<void> {
    await this.loadRepos();
    this.post({ type: "init", repos: this.repos, filter: this.filter });
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

  private async showDetail(repoId: string, sha: string): Promise<void> {
    this.detail.abort();
    const ctl = (this.detail = new AbortController());
    const repo = this.repos.find((r) => r.id === repoId);
    if (!repo || !isSha(sha)) return;
    try {
      const { files, message } = parseShow(await this.deps.run(repo.root, showArgs(sha), ctl.signal));
      this.post({ type: "detail", repoId, sha, files, message });
    } catch (e) {
      if (!isAbortError(e)) this.post({ type: "detail", repoId, sha, files: null, error: messageOf(e) });
    }
  }

  private async openFile(m: Extract<WebviewMessage, { type: "openFile" }>): Promise<void> {
    const repo = this.repos.find((r) => r.id === m.repoId);
    // Refs come from the webview: validate before they reach git.
    if (!repo || !isSha(m.sha) || !(m.parent === null || isSha(m.parent)) || typeof m.path !== "string") return;
    const { before, after } = diffSides(repo.root, { sha: m.sha, parents: m.parent ? [m.parent] : [] }, m);
    const title = `${path.posix.basename(m.path)} (${m.sha.slice(0, 7)}) — ${repo.name}`;
    await vscode.commands.executeCommand("vscode.diff", toUri(before), toUri(after), title, { preview: true });
  }

  private post(m: HostMessage): void {
    void this.panel.webview.postMessage(m);
  }

  dispose(): void {
    this.query.abort();
    this.detail.abort();
    this.reloadSoon.cancel();
    this.reposChangedSoon.cancel();
    for (const d of this.disposables) d.dispose();
    if (LogPanel.current === this) LogPanel.current = undefined;
  }
}
