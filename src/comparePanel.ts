import { randomBytes } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { COMMIT_PAGE, pairDuplicates, pushRecent, summaryLabel, tabTitle, validPair, type Pair, type SideCommit } from "./compareModel";
import type { CCommit, CFile, CompareHost, CompareMode, CompareWebview, CRepoRow } from "./compareProtocol";
import { rowLabel, type CompareStore } from "./compareStore";
import type { LogView } from "./logView";
import { debounce } from "./debounce";
import { isAbortError } from "./pool";
import { isSha, type FileChange } from "./types";
import { renderCompareHtml } from "./webview/compare/html";
import { accentOf, assignAccents } from "./webview/view";

const PAIR = "polylog.compare.pair";
const RECENT = "polylog.compare.recent";
const FAVORITES = "polylog.compare.favorites";
const MODE = "polylog.compare.mode";

export interface CompareSnapshot {
  open: boolean;
  panels: number;
  title: string;
  pair: Pair | null;
  mode: CompareMode;
  message: string | undefined;
  summary: string;
  rows: string[];
  missing: string[];
  selected: string | undefined;
  left: string[];
  right: string[];
  duplicates: string[];
}

const fileLine = (f: CFile) => `${path.posix.basename(f.path)} ${f.added === null ? "binary" : `+${f.added} −${f.deleted}`}${f.both ? " both" : ""}`;
const toFile = (f: FileChange, both: ReadonlySet<string>): CFile => ({ path: f.path, oldPath: f.oldPath, status: f.status, added: f.added, deleted: f.deleted, both: both.has(f.path) });
const toCommit = (c: SideCommit): CCommit => ({ sha: c.sha, parent: c.parents[0] ?? null, subject: c.subject, author: c.author, time: c.time, files: null });

/** The Compare tab: one editor tab, its page, and what it asks the store. */
export class ComparePanel implements vscode.Disposable {
  static readonly viewType = "polylog.compare";
  private panel: vscode.WebviewPanel | undefined;
  private created = 0;
  private selected: string | undefined;
  private detail: { left: CFile[] | CCommit[]; right: CFile[] | CCommit[]; duplicates: string[] } = { left: [], right: [], duplicates: [] };
  private limits = { left: COMMIT_PAGE, right: COMMIT_PAGE };
  private detailSeq = 0;
  private readonly disposables: vscode.Disposable[] = [];
  /** Repositories whose branches moved; vscode.git reports one several times in a burst. */
  private readonly touched = new Set<string>();
  private readonly refreshSoon = debounce(() => {
    const ids = [...this.touched];
    this.touched.clear();
    for (const id of ids) void this.deps.store.refresh(id);
  }, 400);

  constructor(private readonly deps: { context: vscode.ExtensionContext; store: CompareStore; log: LogView }) {
    this.disposables.push(
      deps.store.onDidChange(() => this.postRepos()),
      deps.log.onDidChangeRefs((id) => {
        if (id === undefined) {
          this.touched.clear();
          void deps.store.refresh();
          return;
        }
        this.touched.add(id);
        this.refreshSoon();
      }),
    );
  }

  /** A half-picked pair (Compare with… before a right side exists); never read. */
  private pending: Pair | null = null;

  private get state(): vscode.Memento {
    return this.deps.context.workspaceState;
  }
  private get mode(): CompareMode {
    return this.state.get<CompareMode>(MODE, "files");
  }

  async open(opts: { left?: string } = {}): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
    } else {
      const out = vscode.Uri.joinPath(this.deps.context.extensionUri, "out");
      const panel = vscode.window.createWebviewPanel(ComparePanel.viewType, tabTitle(null), vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [out] });
      this.created++;
      panel.webview.html = renderCompareHtml({
        cspSource: panel.webview.cspSource,
        nonce: randomBytes(16).toString("hex"),
        scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(out, "compare.js")).toString(),
        styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(out, "compare.css")).toString(),
      });
      panel.webview.onDidReceiveMessage((m: CompareWebview) => void this.onMessage(m));
      panel.onDidDispose(() => {
        if (this.panel !== panel) return;
        this.panel = undefined;
        this.selected = undefined;
        void this.deps.store.setPair(null);
      });
      this.panel = panel;
      const saved = this.state.get<Pair>(PAIR);
      const left = opts.left && validPair({ left: opts.left, right: "x" }) ? opts.left : undefined;
      const pair = left ? { left, right: saved?.right ?? "" } : saved;
      if (pair && validPair(pair)) await this.setPair(pair, false);
      // Compare with… and no right side yet: the page shows the left name and opens the picker on the right.
      else if (left) this.pending = { left, right: "" };
    }
    if (this.panel && opts.left && this.deps.store.pair && opts.left !== this.deps.store.pair.left && validPair({ left: opts.left, right: this.deps.store.pair.right })) {
      await this.setPair({ left: opts.left, right: this.deps.store.pair.right });
    }
  }

  private post(m: CompareHost): void {
    void this.panel?.webview.postMessage(m);
  }

  private postState(): void {
    const pair = this.deps.store.pair ?? this.pending ?? (this.state.get<Pair>(PAIR) ?? null);
    const message = pair && pair.left === pair.right ? `Pick two different branches. Both sides are ${pair.left}.` : undefined;
    if (this.panel) this.panel.title = tabTitle(pair);
    this.post({ type: "state", pair, mode: this.mode, recent: this.state.get<Pair[]>(RECENT, []), favorites: this.state.get<string[]>(FAVORITES, []), message });
  }

  private rows(): { rows: CRepoRow[]; identical: number; missing: string[] } {
    const accents = assignAccents(this.deps.log.repoList);
    const rows: CRepoRow[] = [];
    let identical = 0;
    const missing: string[] = [];
    for (const { repo, result } of this.deps.store.results()) {
      if (result.kind === "identical") identical++;
      else if (result.kind === "missing") missing.push(repo.name);
      else rows.push({
        repoId: repo.id, name: repo.name, accent: accentOf(accents, repo.id), status: result.kind,
        left: result.kind === "differs" ? result.left : 0, right: result.kind === "differs" ? result.right : 0, same: result.kind === "differs" ? result.sameLeft : 0,
        reason: result.kind === "error" ? result.reason : undefined, behind: this.deps.log.isBehind(repo.id),
      });
    }
    return { rows, identical, missing };
  }

  private postRepos(): void {
    const { rows, identical, missing } = this.rows();
    const ticked = this.deps.log.tickedRepos().length;
    const summary = ticked === 0 ? "No repositories are ticked in the Repo List."
      : this.deps.store.reading && rows.length === 0 ? `Reading ${ticked} repositories…` : summaryLabel(this.deps.store.results().map((x) => x.result), this.deps.log.tickedRepos().length);
    this.post({ type: "repos", reading: this.deps.store.reading, summary, rows, identical, missing });
    // The selection stays on its repository while it is listed, else the first row.
    if (!rows.some((r) => r.repoId === this.selected) && rows.length > 0) void this.select(rows[0].repoId);
  }

  private async setPair(p: Pair, remember = true): Promise<void> {
    this.pending = null;
    if (remember || !this.state.get(PAIR)) await this.state.update(PAIR, p);
    if (p.left !== p.right) await this.state.update(RECENT, pushRecent(this.state.get<Pair[]>(RECENT, []), p));
    this.selected = undefined;
    this.detail = { left: [], right: [], duplicates: [] };
    this.postState();
    await this.deps.store.setPair(p);
  }

  private async select(repoId: string): Promise<void> {
    this.selected = repoId;
    this.limits = { left: COMMIT_PAGE, right: COMMIT_PAGE };
    await this.readDetail();
  }

  private async readDetail(): Promise<void> {
    const repoId = this.selected;
    if (!repoId) return;
    const seq = ++this.detailSeq;
    const mode = this.mode;
    try {
      if (mode === "files") {
        const f = await this.deps.store.readFiles(repoId);
        const both = new Set(f.both);
        const left = f.left.map((x) => toFile(x, both));
        const right = f.right.map((x) => toFile(x, both));
        const [dl, dr] = await Promise.all([this.deps.store.readCommits(repoId, "left", COMMIT_PAGE), this.deps.store.readCommits(repoId, "right", COMMIT_PAGE)]);
        if (seq !== this.detailSeq) return;
        const duplicates = pairDuplicates(dl.filter((c) => c.mark === "="), dr.filter((c) => c.mark === "="));
        this.detail = { left, right, duplicates: duplicates.map((d) => `${d.subject}${d.left ? " ◀" : ""}${d.right ? " ▶" : ""}`) };
        this.post({ type: "detail", repoId, mode, left, right, more: { left: false, right: false }, duplicates });
      } else {
        const [l, r] = await Promise.all([this.deps.store.readCommits(repoId, "left", this.limits.left + 1), this.deps.store.readCommits(repoId, "right", this.limits.right + 1)]);
        if (seq !== this.detailSeq) return;
        const only = (cs: SideCommit[], max: number) => cs.filter((c) => c.mark === "+").slice(0, max).map(toCommit);
        const left = only(l, this.limits.left);
        const right = only(r, this.limits.right);
        const duplicates = pairDuplicates(l.filter((c) => c.mark === "="), r.filter((c) => c.mark === "="));
        this.detail = { left, right, duplicates: duplicates.map((d) => `${d.subject}${d.left ? " ◀" : ""}${d.right ? " ▶" : ""}`) };
        this.post({ type: "detail", repoId, mode, left, right, more: { left: l.length > this.limits.left, right: r.length > this.limits.right }, duplicates });
      }
    } catch (e) {
      if (isAbortError(e) || seq !== this.detailSeq) return;
      this.post({ type: "detail", repoId, mode, left: [], right: [], more: { left: false, right: false }, duplicates: [], error: e instanceof Error ? e.message : String(e) });
    }
  }

  async onMessage(m: CompareWebview): Promise<void> {
    switch (m?.type) {
      case "ready":
        this.postState();
        this.postRepos();
        if (!this.deps.store.pair) this.post({ type: "branches", names: await this.deps.store.readBranches() });
        return;
      case "pick":
        if (validPair(m.pair)) await this.setPair(m.pair);
        return;
      case "swap": {
        const p = this.deps.store.pair;
        if (!p) return;
        this.deps.store.swap();
        await this.state.update(PAIR, this.deps.store.pair);
        this.postState();
        await this.readDetail();
        return;
      }
      case "mode":
        if (m.mode !== "files" && m.mode !== "commits") return;
        await this.state.update(MODE, m.mode);
        this.postState();
        await this.readDetail();
        return;
      case "refresh":
        await this.deps.store.refresh();
        this.post({ type: "branches", names: await this.deps.store.readBranches() });
        await this.readDetail();
        return;
      case "select":
        if (typeof m.repoId === "string" && this.deps.store.results().some((x) => x.repo.id === m.repoId)) await this.select(m.repoId);
        return;
      case "favorite": {
        if (typeof m.name !== "string") return;
        const favs = new Set(this.state.get<string[]>(FAVORITES, []));
        if (favs.has(m.name)) favs.delete(m.name);
        else favs.add(m.name);
        await this.state.update(FAVORITES, [...favs]);
        this.postState();
        return;
      }
      case "wantBranches":
        this.post({ type: "branches", names: await this.deps.store.readBranches() });
        return;
      case "openFile": {
        const hit = this.deps.store.results().find((x) => x.repo.id === m.repoId);
        if (!hit || hit.result.kind !== "differs" || (m.side !== "left" && m.side !== "right")) return;
        const files = this.detail[m.side] as CFile[];
        const f = files.find((x) => "both" in x && x.path === m.path);
        if (!f) return;
        const tip = m.side === "left" ? hit.result.leftSha : hit.result.rightSha;
        const name = this.deps.store.pair![m.side].replace(/^origin\//, "");
        await this.deps.log.openDiff({ repoId: hit.repo.id, sha: tip, parent: hit.result.base, path: f.path, oldPath: f.oldPath, status: f.status }, false, `${path.posix.basename(f.path)} (merge base ↔ ${name}) — ${hit.repo.name}`);
        return;
      }
      case "expand": {
        if (!isSha(m.sha) || typeof m.repoId !== "string") return;
        const files = await this.deps.store.readCommitFiles(m.repoId, m.sha);
        this.post({ type: "commitFiles", repoId: m.repoId, sha: m.sha, files: files.map((f) => toFile(f, new Set())) });
        return;
      }
      case "openCommitFile": {
        if (!isSha(m.sha) || typeof m.path !== "string") return;
        const c = [...(this.detail.left as CCommit[]), ...(this.detail.right as CCommit[])].find((x) => "sha" in x && x.sha === m.sha);
        if (!c) return;
        const files = await this.deps.store.readCommitFiles(m.repoId, m.sha);
        const f = files.find((x) => x.path === m.path);
        if (f) await this.deps.log.openDiff({ repoId: m.repoId, sha: m.sha, parent: c.parent, path: f.path, oldPath: f.oldPath, status: f.status });
        return;
      }
      case "more":
        if (m.side !== "left" && m.side !== "right") return;
        this.limits[m.side] += COMMIT_PAGE;
        await this.readDetail();
        return;
    }
  }

  snapshot(): CompareSnapshot {
    const pair = this.deps.store.pair ?? (this.state.get<Pair>(PAIR) ?? null);
    const lines = (xs: CFile[] | CCommit[]) => (xs as (CFile | CCommit)[]).map((x) => ("both" in x ? fileLine(x) : x.subject));
    const { missing } = this.rows();
    return {
      open: this.panel !== undefined, panels: this.created, title: this.panel?.title ?? "", pair, mode: this.mode,
      message: pair && pair.left === pair.right ? `Pick two different branches. Both sides are ${pair.left}.` : undefined,
      summary: summaryLabel(this.deps.store.results().map((x) => x.result), this.deps.log.tickedRepos().length),
      rows: this.deps.store.results().map((x) => rowLabel(x.repo.name, x.result)), missing,
      selected: this.selected, left: lines(this.detail.left), right: lines(this.detail.right), duplicates: this.detail.duplicates,
    };
  }

  dispose(): void {
    this.refreshSoon.cancel();
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
