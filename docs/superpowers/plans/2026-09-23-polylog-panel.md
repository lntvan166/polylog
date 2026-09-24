# Polylog Panel View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Polylog from an editor tab into a bottom-panel tab, with the commit list as a webview **Log** view and the changed files as a native **Changes** tree whose file clicks open diffs in the editor area.

**Architecture:** One panel view container (`polylog`) holds a `WebviewViewProvider` (the Log: today's list, filters and paging) and a native `TreeDataProvider` (Changes). The tree's labels, descriptions, tooltips and messages come from a pure, unit-tested `changesModel`; the VS Code adapters stay thin. The host fetches commit detail and feeds the tree; the webview no longer renders files.

**Tech Stack:** unchanged — TypeScript, esbuild, VS Code API `^1.85.0`, plain-`assert` unit tests, `@vscode/test-electron` + mocha.

**Spec:** `docs/superpowers/specs/2026-09-23-polylog-panel-design.md` (amends `docs/superpowers/specs/2026-09-23-polylog-design.md`). Standing rules: `CLAUDE.md`.

## Global Constraints

- No index, cache or database; every filter stays a `git log` flag. The Changes tree holds only the selected commit's detail.
- All webview color and type from `--vscode-*` variables (`npm run check:theme`). The tree uses native `ThemeIcon`s and `resourceUri` for the file-icon theme; the panel icon `media/polylog.svg` draws only with `currentColor`.
- Neutral fixtures only (`acme-*`, `dana`, `rin`, `ACME-<n>`). No employer or internal names.
- Never block the extension host; detail spawns abort when a newer commit is selected.
- Every SHA or parent that arrives from the webview or a tree command passes `isSha()` before reaching git.
- Do not publish, tag or bump `version` (stays `0.0.0`); no CHANGELOG.
- Commit only as `lntvan166 <lntvan166@gmail.com>` on `feat/polylog-v1`; `git add <files>` + `git commit` only.
- Every new `src/*.test.ts` is appended to `test:unit`.

## Review Focus

1. **Holding ↓ through the log** fires a select per row; the tree must end on the last selected commit, never a slower earlier one. → Task 3 itest "the tree follows the last selection".
2. **Enter before the file list has loaded** should open the first text file once it arrives, exactly once. → Task 3 itest "Enter opens the first file even before the list loads".
3. **A commit with no text files** (empty, or only binary): the tree says so and Enter does nothing. → Task 1 unit (messages, `openable`) and Task 2 `firstOpenable`.
4. **The panel hidden and shown** (switching to Terminal and back) must not rebuild the webview. → Task 3 itest `readyCount`.
5. **A non-SHA ref** in `select`, `openFirst` or `polylog.openDiff` is rejected before git. → Task 3 itest.

---

## File Structure

```
src/fileTree.ts            moved from src/webview/view.ts (pure)
src/fileTree.test.ts       moved fileTree test
src/changesModel.ts        ChangesState → node descriptors + view message (pure)
src/changesModel.test.ts
src/changesTree.ts         vscode TreeDataProvider over changesModel
src/logView.ts             vscode WebviewViewProvider (replaces src/logPanel.ts)
src/extension.ts           registers both views and four commands
src/protocol.ts            drop "detail"/"openFile", add "openFirst"
src/webview/{main.ts,html.ts,styles.css,view.ts}   detail pane removed
src/webview/detail.ts, src/logPanel.ts             deleted
media/polylog.svg          panel icon (currentColor)
dev/harness/{shim.ts,mock.ts}                      detail removed
src/integration/log.itest.ts                       rewritten for the panel
```

---

### Task 1: Pure tree model (`fileTree`, `changesModel`)

**Files:**
- Create: `src/fileTree.ts`, `src/fileTree.test.ts`, `src/changesModel.ts`, `src/changesModel.test.ts`
- Modify: `src/webview/view.ts` (remove `TreeFolder`, `TreeFile`, `TreeNode`, `fileTree`; drop the now-unused `FileChange` import), `src/webview/view.test.ts` (remove the `fileTree` block and its import), `package.json` (`test:unit`)

**Interfaces:**
- Consumes: `Commit`, `FileChange` (`src/types.ts`); `relativeTime`, `absoluteTime` (`src/webview/view.ts`).
- Produces:
  - `src/fileTree.ts`: `TreeFolder`, `TreeFile`, `TreeNode`, `fileTree(files: readonly FileChange[]): TreeNode[]` — unchanged behavior.
  - `src/changesModel.ts`:
    - `type ChangesStatus = "loading" | "ready" | "error"`
    - `interface ChangesState { commit: Commit; repoRoot: string; repoName: string; status: ChangesStatus; files: FileChange[]; message: string; error?: string }`
    - `type NodeDesc = CommitDesc | FolderDesc | FileDesc` where
      `CommitDesc { kind: "commit"; id; label; description; tooltip; children: NodeDesc[] }`,
      `FolderDesc { kind: "folder"; id; label; description; tooltip; path; children: NodeDesc[] }`,
      `FileDesc { kind: "file"; id; label; description; tooltip; path; file: FileChange; openable: boolean }` (all string fields)
    - `describeChanges(s: ChangesState | null, now: number): { message: string | undefined; roots: NodeDesc[] }`
    - `firstOpenable(files: readonly FileChange[]): FileChange | undefined`
    - `NO_SELECTION`, `LOADING`, `NO_FILES` message constants

- [ ] **Step 1: Write the failing tests**

`src/fileTree.test.ts` (moved from `view.test.ts`, import path changed):
```ts
import * as assert from "assert";
import { fileTree } from "./fileTree";

{
  const f = (path: string) => ({ path, added: 1, deleted: 0 });
  const tree = fileTree([f("src/client.ts"), f("internal/upload/upload_test.go"), f("README.md"), f("internal/upload/upload.go")]);
  const shape = (nodes: ReturnType<typeof fileTree>): unknown => nodes.map((n) => n.kind === "folder" ? [n.name, n.count, shape(n.children)] : n.name);
  assert.deepStrictEqual(shape(tree), [["internal/upload", 2, ["upload.go", "upload_test.go"]], ["src", 1, ["client.ts"]], "README.md"]);
  assert.deepStrictEqual(shape(fileTree([f("a/b/x.ts"), f("a/c/y.ts")])), [["a", 2, [["b", 1, ["x.ts"]], ["c", 1, ["y.ts"]]]]]);
  assert.deepStrictEqual(fileTree([]), []);
  console.log("ok - fileTree groups by folder, folders first, single-child chains compressed");
}
```

`src/changesModel.test.ts`:
```ts
import * as assert from "assert";
import { describeChanges, firstOpenable, LOADING, NO_FILES, NO_SELECTION, type ChangesState, type NodeDesc } from "./changesModel";
import type { Commit } from "./types";

const NOW = 1790164800;
const commit: Commit = {
  repoId: "/ws/acme-api", sha: "1596c39".padEnd(40, "0"), time: NOW - 2 * 3600, author: "rin", email: "rin@example.com",
  subject: "feat: add retry to uploader (ACME-7)", parents: ["b".repeat(40)],
};
const state = (over: Partial<ChangesState> = {}): ChangesState => ({
  commit, repoRoot: "/ws/acme-api", repoName: "acme-api", status: "ready", message: "feat: add retry to uploader (ACME-7)\n\nfunc: ACME_UPLOAD_005\ntask: ACME-7",
  files: [
    { path: "internal/upload/upload.go", added: 42, deleted: 7 },
    { path: "internal/upload/upload_test.go", added: 88, deleted: 0 },
    { path: "assets/logo.png", added: null, deleted: null },
    { path: "docs/releases.md", oldPath: "docs/release.md", added: 0, deleted: 0 },
  ],
  ...over,
});
const flat = (nodes: NodeDesc[], depth = 0): string[] =>
  nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.label} | ${n.description}`, ...(n.kind === "file" ? [] : flat(n.children, depth + 1))]);

{
  const { message, roots } = describeChanges(state(), NOW);
  assert.strictEqual(message, undefined);
  assert.deepStrictEqual(flat(roots), [
    "feat: add retry to uploader (ACME-7) | 1596c39 · rin · 2h ago",
    "  assets | 1",
    "    logo.png | binary",
    "  docs | 1",
    "    releases.md | ← docs/release.md  +0 −0",
    "  internal/upload | 2",
    "    upload.go | +42 −7",
    "    upload_test.go | +88 −0",
  ]);
  console.log("ok - commit node on top, then the folder tree with +/− descriptions");
}
{
  const [root] = describeChanges(state(), NOW).roots;
  assert.strictEqual(root.kind, "commit");
  assert.ok(root.tooltip.startsWith("feat: add retry to uploader (ACME-7)\n\nfunc: ACME_UPLOAD_005\ntask: ACME-7\n\n"), "full message keeps its line breaks");
  assert.match(root.tooltip, /rin <rin@example\.com> · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · acme-api/);
  assert.ok(root.tooltip.endsWith(commit.sha));
  console.log("ok - the commit tooltip carries the full message, author email, date, repo and SHA");
}
{
  const files = (describeChanges(state(), NOW).roots[0] as { children: NodeDesc[] }).children.flatMap((n) => (n.kind === "folder" ? n.children : [n]));
  const byLabel = new Map(files.map((n) => [n.label, n]));
  const logo = byLabel.get("logo.png")!;
  const upload = byLabel.get("upload.go")!;
  assert.ok(logo.kind === "file" && !logo.openable, "binary files cannot be opened as a text diff");
  assert.ok(upload.kind === "file" && upload.openable && upload.path === "internal/upload/upload.go");
  assert.strictEqual(upload.tooltip, "internal/upload/upload.go");
  assert.strictEqual(byLabel.get("releases.md")!.tooltip, "docs/release.md → docs/releases.md");
  console.log("ok - files carry their full path; binaries are not openable; renames show both paths");
}
{
  const ids = (nodes: NodeDesc[]): string[] => nodes.flatMap((n) => [n.id, ...(n.kind === "file" ? [] : ids(n.children))]);
  const all = ids(describeChanges(state(), NOW).roots);
  assert.strictEqual(new Set(all).size, all.length, "ids are unique so VS Code keeps expand state");
  assert.deepStrictEqual(ids(describeChanges(state(), NOW + 60).roots), all, "ids do not depend on time");
  console.log("ok - node ids are unique and stable");
}
{
  assert.deepStrictEqual(describeChanges(null, NOW), { message: NO_SELECTION, roots: [] });
  assert.strictEqual(NO_SELECTION, "Select a commit in the Log to see its changed files.");
  const loading = describeChanges(state({ status: "loading", files: [] }), NOW);
  assert.strictEqual(loading.message, LOADING);
  assert.strictEqual(loading.roots.length, 1, "the commit node shows while its files load");
  assert.strictEqual(describeChanges(state({ status: "error", files: [], error: "bad object" }), NOW).message, "Could not read this commit: bad object");
  assert.strictEqual(describeChanges(state({ files: [] }), NOW).message, NO_FILES);
  console.log("ok - no selection, loading, error and no-files each have a message");
}
{
  assert.strictEqual(firstOpenable(state().files)?.path, "internal/upload/upload.go");
  assert.strictEqual(firstOpenable([{ path: "a.png", added: null, deleted: null }]), undefined);
  assert.strictEqual(firstOpenable([]), undefined);
  console.log("ok - firstOpenable skips binaries and is undefined when nothing can be opened");
}
```

Append to `test:unit`:
```
 && esbuild src/fileTree.test.ts --bundle --platform=node --format=cjs --outfile=out/fileTree.test.cjs && node out/fileTree.test.cjs && esbuild src/changesModel.test.ts --bundle --platform=node --format=cjs --outfile=out/changesModel.test.cjs && node out/changesModel.test.cjs
```

Remove from `src/webview/view.test.ts`: `fileTree` from the import list, and the whole block that starts `const f = (path: string) => ({ path, added: 1, deleted: 0 });` and ends with `console.log("ok - fileTree groups by folder…")`.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:unit`
Expected: FAIL, `Could not resolve "./fileTree"`.

- [ ] **Step 3: Implement**

`src/fileTree.ts` — cut `TreeFolder`, `TreeFile`, `TreeNode` and `fileTree` verbatim from `src/webview/view.ts` into this file, with this header:
```ts
import type { FileChange } from "./types";
```
In `src/webview/view.ts`, change `import { commitKey, type FileChange } from "../types";` back to `import { commitKey } from "../types";`.

`src/changesModel.ts`:
```ts
import { fileTree, type TreeNode } from "./fileTree";
import { commitKey, type Commit, type FileChange } from "./types";
import { absoluteTime, relativeTime } from "./webview/view";

export type ChangesStatus = "loading" | "ready" | "error";

export interface ChangesState {
  commit: Commit;
  repoRoot: string;
  repoName: string;
  status: ChangesStatus;
  files: FileChange[];
  /** Full commit message; "" until loaded. */
  message: string;
  error?: string;
}

interface Base {
  /** Stable across re-renders so VS Code keeps each folder's expand state. */
  id: string;
  label: string;
  description: string;
  tooltip: string;
}
export interface CommitDesc extends Base { kind: "commit"; children: NodeDesc[] }
export interface FolderDesc extends Base { kind: "folder"; path: string; children: NodeDesc[] }
export interface FileDesc extends Base { kind: "file"; path: string; file: FileChange; openable: boolean }
export type NodeDesc = CommitDesc | FolderDesc | FileDesc;

export const NO_SELECTION = "Select a commit in the Log to see its changed files.";
export const LOADING = "Loading changed files…";
export const NO_FILES = "This commit changes no files.";

export function firstOpenable(files: readonly FileChange[]): FileChange | undefined {
  return files.find((f) => f.added !== null);
}

function stat(f: FileChange): string {
  if (f.added === null) return "binary";
  const counts = `+${f.added} −${f.deleted}`;
  return f.oldPath ? `← ${f.oldPath}  ${counts}` : counts;
}

function describeNodes(nodes: readonly TreeNode[], parent: string, base: string): NodeDesc[] {
  return nodes.map((n): NodeDesc => {
    if (n.kind === "folder") {
      const path = parent ? `${parent}/${n.name}` : n.name;
      return { kind: "folder", id: `${base}/d:${path}`, label: n.name, description: String(n.count), tooltip: path, path, children: describeNodes(n.children, path, base) };
    }
    const f = n.file;
    return {
      kind: "file", id: `${base}/f:${f.path}`, label: n.name, description: stat(f),
      tooltip: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path, path: f.path, file: f, openable: f.added !== null,
    };
  });
}

/** Everything the Changes tree shows, as plain data. The VS Code adapter only maps it to TreeItems. */
export function describeChanges(s: ChangesState | null, now: number): { message: string | undefined; roots: NodeDesc[] } {
  if (!s) return { message: NO_SELECTION, roots: [] };
  const c = s.commit;
  const base = commitKey(c);
  const tooltip = `${s.message || c.subject}\n\n${c.author} <${c.email}> · ${absoluteTime(c.time)} · ${s.repoName}\n${c.sha}`;
  const children = s.status === "ready" ? describeNodes(fileTree(s.files), "", base) : [];
  const root: CommitDesc = { kind: "commit", id: base, label: c.subject, description: `${c.sha.slice(0, 7)} · ${c.author} · ${relativeTime(now, c.time)}`, tooltip, children };
  const message =
    s.status === "loading" ? LOADING
    : s.status === "error" ? `Could not read this commit: ${s.error ?? "unknown error"}`
    : s.files.length === 0 ? NO_FILES
    : undefined;
  return { message, roots: [root] };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit && npm run typecheck`
Expected: every `ok - …` including the seven new ones; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/fileTree.ts src/fileTree.test.ts src/changesModel.ts src/changesModel.test.ts src/webview/view.ts src/webview/view.test.ts package.json
git commit -m "feat: pure model for the native Changes tree

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Panel container, Log view and Changes tree

**Files:**
- Create: `src/changesTree.ts`, `src/logView.ts`, `media/polylog.svg`
- Delete: `src/logPanel.ts`, `src/webview/detail.ts`
- Modify: `src/extension.ts`, `src/protocol.ts`, `src/webview/main.ts`, `src/webview/html.ts`, `src/webview/html.test.ts`, `src/webview/styles.css`, `dev/harness/shim.ts`, `dev/harness/mock.ts`, `package.json` (contributions), `.vscodeignore`

**Interfaces:**
- Consumes: `describeChanges`, `firstOpenable`, `ChangesState`, `NodeDesc` (Task 1); everything `logPanel.ts` used.
- Produces:
  - `class ChangesTree implements vscode.TreeDataProvider<NodeDesc>, vscode.Disposable { set(s: ChangesState | null): void; current(): ChangesState | null; snapshot(): ChangesSnapshot }`
  - `interface ChangesSnapshot { message: string | undefined; items: string[] }` — items are `"  ".repeat(depth) + label + " | " + description`
  - `interface OpenDiffArgs { repoId: string; sha: string; parent: string | null; path: string; oldPath?: string }`
  - `class LogView implements vscode.WebviewViewProvider, vscode.Disposable { static readonly id = "polylog.log"; onMessage(m: WebviewMessage): Promise<void>; openDiff(a: OpenDiffArgs): Promise<void>; snapshot(): LogSnapshot }`
  - `interface LogSnapshot { repos; filter; rows; failures; done; readyCount: number; changes: ChangesSnapshot }`
  - Protocol: `WebviewMessage` gains `{ type: "openFirst"; repoId: string; sha: string }`, loses `openFile`; `HostMessage` loses `detail`.
  - Commands: `polylog.open`, `polylog.openDiff(OpenDiffArgs)`, `polylog.copySha`, `polylog.copyMessage`; test seams `polylog._itest.snapshot` → `LogSnapshot`, `polylog._itest.send(WebviewMessage)`.

This task has no new unit test: the logic it adds is in Task 1's model; the VS Code wiring is covered by Task 3's integration suite. The gate here is typecheck, the existing unit suite, and the harness.

- [ ] **Step 1: Protocol**

Replace the two unions in `src/protocol.ts` with:
```ts
/** Extension host → webview. */
export type HostMessage =
  | { type: "init"; repos: Repo[]; filter: FilterState }
  | { type: "loading" }
  | { type: "page"; rows: Commit[]; append: boolean; failures: RepoFailure[]; done: boolean; now: number };

/** Webview → extension host. Every field is untrusted until validated. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "filter"; filter: FilterState }
  | { type: "loadMore" }
  | { type: "refresh" }
  | { type: "select"; repoId: string; sha: string }
  | { type: "openFirst"; repoId: string; sha: string }
  | { type: "openSettings" };
```
and change its type import to `import type { Commit, Repo, RepoFailure } from "./types";`.

- [ ] **Step 2: `src/changesTree.ts`**

```ts
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
```

- [ ] **Step 3: `src/logView.ts`**

Create it from `src/logPanel.ts` with these differences, then `git rm src/logPanel.ts`:
```ts
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
import type { HostMessage, WebviewMessage } from "./protocol";
import type { RepoDiscovery } from "./repoDiscovery";
import { encodeRevision, SCHEME, type RevisionRef } from "./revisionUri";
import { readSettings } from "./settings";
import { commitKey, isSha, type Commit, type Repo, type RepoFailure } from "./types";
import { renderHtml } from "./webview/html";

const FILTER_KEY = "polylog.filter";
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
  changes: ChangesSnapshot;
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
```
Keep `onMessage` as in `logPanel.ts`, with the `select`/`openFile` cases replaced by:
```ts
      case "select":
        await this.showDetail(m.repoId, m.sha);
        return;
      case "openFirst":
        await this.openFirst(m.repoId, m.sha);
        return;
```
Keep `settings`, `loadRepos`, `refreshRepos`, `reload`, `loadMore` unchanged. Replace `snapshot`, `showDetail`, `openFile`, `post`, `dispose` with:
```ts
  snapshot(): LogSnapshot {
    return {
      repos: this.repos, filter: this.filter, rows: this.rows, failures: this.failures, done: this.done,
      readyCount: this.readyCount, changes: this.deps.changes.snapshot(),
    };
  }

  private findCommit(repoId: string, sha: string): { commit: Commit; repo: Repo } | undefined {
    if (!isSha(sha)) return undefined;
    const repo = this.repos.find((r) => r.id === repoId);
    const commit = this.rows.find((c) => c.repoId === repoId && c.sha === sha);
    return repo && commit ? { commit, repo } : undefined;
  }

  private async showDetail(repoId: string, sha: string): Promise<void> {
    this.detail.abort();
    const ctl = (this.detail = new AbortController());
    const found = this.findCommit(repoId, sha);
    if (!found) return;
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
```

- [ ] **Step 4: `src/extension.ts`**

```ts
import * as vscode from "vscode";
import { ChangesTree, type OpenDiffArgs } from "./changesTree";
import { runGit } from "./git";
import { LogView } from "./logView";
import type { WebviewMessage } from "./protocol";
import { RepoDiscovery } from "./repoDiscovery";
import { RevisionProvider } from "./revisionProvider";
import { SCHEME } from "./revisionUri";

export function activate(context: vscode.ExtensionContext): void {
  const discovery = new RepoDiscovery();
  const changes = new ChangesTree();
  const log = new LogView(context, { discovery, run: runGit, changes });
  context.subscriptions.push(
    discovery,
    changes,
    log,
    // Retained: switching the panel to Terminal and back must keep selection and scroll.
    vscode.window.registerWebviewViewProvider(LogView.id, log, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionProvider(runGit)),
    vscode.commands.registerCommand("polylog.open", () => vscode.commands.executeCommand(`${LogView.id}.focus`)),
    vscode.commands.registerCommand("polylog.openDiff", (a: OpenDiffArgs) => log.openDiff(a)),
    vscode.commands.registerCommand("polylog.copySha", () => {
      const s = changes.current();
      if (s) void vscode.env.clipboard.writeText(s.commit.sha);
    }),
    vscode.commands.registerCommand("polylog.copyMessage", () => {
      const s = changes.current();
      if (s) void vscode.env.clipboard.writeText(s.message || s.commit.subject);
    }),
  );
  // Test seam for the integration suite only; never registered for users.
  if (process.env.POLYLOG_ITEST === "1") {
    context.subscriptions.push(
      vscode.commands.registerCommand("polylog._itest.snapshot", () => log.snapshot()),
      vscode.commands.registerCommand("polylog._itest.send", (m: WebviewMessage) => log.onMessage(m)),
    );
  }
}

export function deactivate(): void {}
```

- [ ] **Step 5: Contributions, icon, packaging**

Replace `activationEvents` and `contributes.commands` in `package.json`, and add `viewsContainers`, `views` and `menus` (keep `configuration` as is):
```json
"activationEvents": ["onCommand:polylog.open", "onView:polylog.log", "onView:polylog.changes"],
"contributes": {
  "viewsContainers": {
    "panel": [{ "id": "polylog", "title": "Polylog", "icon": "media/polylog.svg" }]
  },
  "views": {
    "polylog": [
      { "type": "webview", "id": "polylog.log", "name": "Log" },
      { "id": "polylog.changes", "name": "Changes" }
    ]
  },
  "commands": [
    { "command": "polylog.open", "title": "Open Merged Log", "category": "Polylog" },
    { "command": "polylog.openDiff", "title": "Open Diff", "category": "Polylog" },
    { "command": "polylog.copySha", "title": "Copy SHA", "category": "Polylog" },
    { "command": "polylog.copyMessage", "title": "Copy Message", "category": "Polylog" }
  ],
  "menus": {
    "view/item/context": [
      { "command": "polylog.copySha", "when": "view == polylog.changes && viewItem == commit", "group": "copy@1" },
      { "command": "polylog.copyMessage", "when": "view == polylog.changes && viewItem == commit", "group": "copy@2" }
    ],
    "commandPalette": [
      { "command": "polylog.openDiff", "when": "false" },
      { "command": "polylog.copySha", "when": "false" },
      { "command": "polylog.copyMessage", "when": "false" }
    ]
  },
  "configuration": { … unchanged … }
}
```

`media/polylog.svg` (three merged lanes into one; `currentColor` only):
```svg
<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
  <path d="M2 3h4.5c1.5 0 2.5 1 2.5 2.5V8"/>
  <path d="M2 13h4.5C8 13 9 12 9 10.5V8"/>
  <path d="M2 8h12"/>
  <circle cx="12.5" cy="8" r="1.5" fill="currentColor"/>
</svg>
```

In `.vscodeignore`, add `!media/polylog.svg` after `!LICENSE`.

- [ ] **Step 6: Webview — remove the detail pane**

1. `git rm src/webview/detail.ts`.
2. `src/webview/html.ts`: replace `<main class="split">` with `<main class="main">` and delete the line `    <aside id="detail" class="detail" aria-label="Changed files"></aside>`.
3. `src/webview/html.test.ts`: remove `"detail", ` from the id list.
4. `src/webview/main.ts`:
   - remove `import { DetailPane } from "./detail";`, `FileChange` from the types import, the `Detail` interface, the `detail` and `openWhenLoaded` fields of `state`, the `const detail = new DetailPane(…)` block, the `case "detail":` branch, the `openFile` function, and the `detail.render(…)` line in `render()`;
   - add `let selectedKey: string | null = null;` next to `let skeletonTimer`;
   - replace `select` and `openFirstFile` with:
```ts
function select(index: number, andRender = true): void {
  state.selected = index;
  const c = state.rows[index];
  const key = c ? commitKey(c) : null;
  if (c && key !== selectedKey) post({ type: "select", repoId: c.repoId, sha: c.sha });
  selectedKey = key;
  if (andRender) render();
}

/** Enter: the host opens the selected commit's first text file in the editor area. */
function openFirstFile(): void {
  const c = state.rows[state.selected];
  if (c) post({ type: "openFirst", repoId: c.repoId, sha: c.sha });
}
```
5. `src/webview/styles.css`:
   - replace the `.split` and `.list-pane` rules with
     `.main { display: grid; min-height: 0; }` and `.list-pane { display: grid; min-height: 0; }`;
   - delete everything from the comment `/* Detail: file tree on top, the full commit message underneath. */` up to (not including) `.hint {`, keeping `.hint` and `.error`;
   - in the high-contrast hover rule, delete the `body.vscode-high-contrast .file:hover,` and `body.vscode-high-contrast .folder > summary:hover,` selectors;
   - in `@media (max-width: 720px)`, delete the `.split { … }` and `.list-pane { … }` lines (keep the `.row` rules).
6. `dev/harness/shim.ts`: remove `mockFiles` from the `./mock` import and replace the `case "select": { … }` block and the `openFile` case with
   `case "select": case "openFirst": console.info(\`[harness] ${m.type}\`, m); return;`.
7. `dev/harness/mock.ts`: delete `mockFiles` and change its import to `import type { Commit, Repo } from "../../src/types";`.

- [ ] **Step 7: Verify**

Run: `npm run lint && npm run typecheck && npm run check:theme && npm run compile && npm test && npm run check:design`
Expected: all pass. Then `grep -rn '"detail"\|openFile\|DetailPane' src/webview src/protocol.ts` prints nothing.

Run: `npm run harness`, open `/gallery.html?state=many`.
Expected: the Log fills the full width in all four themes; selecting rows logs `[harness] select`, Enter logs `[harness] openFirst`; no console errors.

- [ ] **Step 8: Commit**

```bash
git add -A src/logView.ts src/changesTree.ts src/extension.ts src/protocol.ts src/webview media/polylog.svg dev/harness/shim.ts dev/harness/mock.ts package.json .vscodeignore
git commit -m "feat: Polylog panel with a Log view and a native Changes tree

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Integration suite for the panel, docs

**Files:**
- Modify: `src/integration/log.itest.ts` (rewrite), `README.md`, `PRODUCT.md` (Operating Context and Platform lines)

**Interfaces:**
- Consumes: `LogSnapshot` (`src/logView.ts`), `OpenDiffArgs` (`src/changesTree.ts`), commands from Task 2, `EXPECTED_ORDER` (`src/integration/fixture.ts`).

- [ ] **Step 1: Rewrite `src/integration/log.itest.ts`**

```ts
import * as assert from "assert";
import * as vscode from "vscode";
import type { OpenDiffArgs } from "../changesTree";
import type { LogSnapshot } from "../logView";
import type { WebviewMessage } from "../protocol";
import type { Commit } from "../types";
import { EXPECTED_ORDER } from "./fixture";

const snapshot = () => vscode.commands.executeCommand<LogSnapshot>("polylog._itest.snapshot");
const send = (m: WebviewMessage) => vscode.commands.executeCommand("polylog._itest.send", m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ALL = { text: "", repoIds: null, date: "all" as const };

async function waitFor<T>(what: string, probe: () => PromiseLike<T | undefined> | T | undefined, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}
const until = (what: string, ok: (s: LogSnapshot) => boolean) =>
  waitFor(what, async () => {
    const s = await snapshot();
    return s && ok(s) ? s : undefined;
  });
const diffTab = () =>
  waitFor("a diff editor", () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff && input.modified.scheme === "polylog" ? input : undefined;
  });
const tabCount = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
const closeEditors = () => vscode.commands.executeCommand("workbench.action.closeAllEditors");
const args = (c: Commit, path: string): OpenDiffArgs => ({ repoId: c.repoId, sha: c.sha, parent: c.parents[0] ?? null, path });
const bySubject = (s: LogSnapshot, prefix: string) => s.rows.find((r) => r.subject.startsWith(prefix))!;

describe("Polylog panel", () => {
  before(async () => {
    await vscode.commands.executeCommand("polylog.open");
    await until("the Log webview", (s) => s.readyCount >= 1 && s.repos.length === 3);
    await send({ type: "filter", filter: ALL });
  });

  it("merges commits from every repository, newest first", async () => {
    const s = await until("six rows", (x) => x.rows.length === 6);
    assert.deepStrictEqual(s.rows.map((r) => r.subject), EXPECTED_ORDER);
    assert.strictEqual(new Set(s.rows.map((r) => r.repoId)).size, 3);
  });

  it("narrows by message and by repository", async () => {
    await send({ type: "filter", filter: { ...ALL, text: "acme-7" } });
    let s = await until("two ACME-7 rows", (x) => x.rows.length === 2);
    assert.deepStrictEqual(s.rows.map((r) => r.subject), ["docs: link ACME-7 from the changelog", "feat: add retry to uploader (ACME-7)"]);
    const web = s.repos.find((r) => r.name === "acme-web")!;
    await send({ type: "filter", filter: { ...ALL, repoIds: [web.id] } });
    s = await until("acme-web rows only", (x) => x.rows.length === 2 && x.rows.every((r) => r.repoId === web.id));
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("fills the native Changes tree when a commit is selected", async () => {
    const c = bySubject(await snapshot(), "feat: add retry");
    await send({ type: "select", repoId: c.repoId, sha: c.sha });
    const s = await until("the tree for the retry commit", (x) => x.changes.items.some((i) => i.includes("upload.go")));
    assert.strictEqual(s.changes.message, undefined);
    assert.match(s.changes.items[0], /^feat: add retry to uploader \(ACME-7\) \| [0-9a-f]{7} · rin · /);
    assert.deepStrictEqual(s.changes.items.slice(1), ["  upload.go | +2 −0"]);
  });

  it("the tree follows the last selection, not a slower earlier one", async () => {
    const s0 = await snapshot();
    const a = bySubject(s0, "chore: bump deps");
    const b = bySubject(s0, "fix: guard nil");
    // Not awaited: the second selection must race the first, as holding ↓ does.
    void send({ type: "select", repoId: a.repoId, sha: a.sha });
    await send({ type: "select", repoId: b.repoId, sha: b.sha });
    const s = await until("the tree for the last selection", (x) => x.changes.items[0]?.startsWith("fix: guard nil") && x.changes.message === undefined);
    await sleep(500);
    assert.ok((await snapshot()).changes.items[0].startsWith("fix: guard nil"), "an earlier, slower detail overwrote the tree");
    assert.deepStrictEqual(s.changes.items.slice(1), ["  client.ts | +1 −1"]);
  });

  it("opens a file's diff in the editor area", async () => {
    await closeEditors();
    const c = bySubject(await snapshot(), "feat: add retry");
    await vscode.commands.executeCommand("polylog.openDiff", args(c, "upload.go"));
    const input = await diffTab();
    assert.strictEqual((await vscode.workspace.openTextDocument(input.original)).getText(), "package upload\n");
    assert.match((await vscode.workspace.openTextDocument(input.modified)).getText(), /func Retry/);
  });

  it("shows an empty before side for a root commit", async () => {
    await closeEditors();
    const c = bySubject(await snapshot(), "feat: scaffold api");
    await vscode.commands.executeCommand("polylog.openDiff", args(c, "upload.go"));
    const input = await diffTab();
    assert.strictEqual((await vscode.workspace.openTextDocument(input.original)).getText(), "");
  });

  it("Enter opens the first file even before the list loads", async () => {
    await closeEditors();
    const c = bySubject(await snapshot(), "docs: link ACME-7");
    // Not awaited: Enter lands while the file list is still loading.
    void send({ type: "select", repoId: c.repoId, sha: c.sha });
    await send({ type: "openFirst", repoId: c.repoId, sha: c.sha });
    const input = await diffTab();
    assert.match(input.modified.path, /CHANGELOG\.md$/);
    await sleep(300);
    assert.strictEqual(tabCount(), 1, "opened exactly once");
  });

  it("rejects refs that are not SHAs", async () => {
    await closeEditors();
    const c = (await snapshot()).rows[0];
    const bad = "--output=/tmp/polylog-pwned";
    await vscode.commands.executeCommand("polylog.openDiff", { ...args(c, "x"), sha: bad });
    await send({ type: "openFirst", repoId: c.repoId, sha: bad });
    await send({ type: "select", repoId: c.repoId, sha: bad });
    await sleep(300);
    assert.strictEqual(tabCount(), 0);
  });

  it("keeps the Log alive when the panel shows another tab", async () => {
    const before = (await snapshot()).readyCount;
    await vscode.commands.executeCommand("workbench.action.terminal.focus");
    await sleep(500);
    await vscode.commands.executeCommand("polylog.open");
    await sleep(1000);
    assert.strictEqual((await snapshot()).readyCount, before, "the webview was destroyed and re-created");
  });
});
```

- [ ] **Step 2: Run it**

Run: `xvfb-run -a npm run test:integration`
Expected: `9 passing`. If "the tree follows the last selection" fails, the stale-result guard in `LogView.showDetail` is broken — fix the code, not the test.

- [ ] **Step 3: Docs**

`README.md`, "Using it" section — replace its first line with:
```
Run **Polylog: Open Merged Log** from the Command Palette. Polylog opens as a tab in the
bottom panel, next to Terminal: the **Log** on the left, the native **Changes** tree on the
right. Clicking a file opens its diff in the editor area above. Right-click the commit in
Changes to copy its SHA or message.
```
and change the `Enter` row to `Open the selected commit's first changed file in the editor area`.

`PRODUCT.md`: under **Platform**, change "A VS Code webview rendered in an editor tab." to "A VS Code panel view (Log webview beside a native Changes tree), next to Terminal."; under **Operating Context**, change "Lives in an editor tab next to the user's code; opened on demand via `polylog.open`." to "Lives in the bottom panel beside Terminal; diffs open in the editor area above. Opened on demand via `polylog.open`."

- [ ] **Step 4: Full verification and commit**

Run: `npm run lint && npm run typecheck && npm test && npm run check:theme && npm run check:design && xvfb-run -a npm run test:integration && npx vsce ls --no-dependencies`
Expected: all green; `vsce ls` lists `package.json`, `README.md`, `LICENSE`, `media/polylog.svg`, `out/extension.js`, `out/webview.js`, `out/webview.css`.

```bash
git add src/integration/log.itest.ts README.md PRODUCT.md
git commit -m "test: integration suite for the panel view and Changes tree

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
