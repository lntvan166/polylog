# Uncommitted View, Review Switch and All Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give uncommitted work its own native view with staging and commit, add a Commits | Uncommitted switch to the Log, and an All Files mode to the Changes view, removing the eye, the pinned rows, Review mode's old UI and `keepViewsExpanded`.

**Architecture:** A pure model (`uncommittedModel.ts`) and a status splitter (`workingTree.ts`) carry the logic and the tests. A store (`uncommittedStore.ts`) takes over the uncommitted reads from `logView.ts` and feeds two consumers: the native Uncommitted view (`uncommittedView.ts`) and the Log's switch (webview). Git writes (stage, unstage, discard, commit) go through vscode.git's API via `RepoDiscovery`. All Files reads a commit's tree lazily, one folder per `git ls-tree`.

**Tech Stack:** TypeScript, esbuild, VS Code extension API (TreeView, webview view, vscode.git API v1), plain-assert unit tests, @vscode/test-electron integration tests (stable and 1.85).

**Spec:** `docs/superpowers/specs/2026-10-01-uncommitted-view-design.md` (section numbers below refer to it). Visual reference: brainstorm companion `demo-project1-v6.html`. Part names: `dev/ui-map/index.html`.

## Global Constraints

- No index, no cache, no database; every filter is a git argument (CLAUDE.md 1). The uncommitted store is state kept current by git reads on events, as in 0.5.0, not a cache.
- All color and type from `--vscode-*` / `ThemeColor` / `ThemeIcon`; no hex in webview CSS; must work in light, dark, high contrast (CLAUDE.md 2). `npm run check:theme && npm run check:design` stay green.
- Neutral fixtures only: `acme-web`, `acme-api`, `acme-libs`, `acme-docs`, `dana`, `rin` (CLAUDE.md 3). `npm run check:denylist` before every commit, chained with `&&`.
- Never block the extension host: async spawns only, pooled by `settings().maxConcurrency` (CLAUDE.md 4).
- Do not bump the version, edit CHANGELOG, tag or publish (CLAUDE.md 5). The CHANGELOG entry is written at release.
- Unit tests are plain `assert` + `console.log("ok - …")`; each new `src/*.test.ts` is appended to `test:unit` in `package.json`.
- Integration tests in `src/integration/log.itest.ts`, run with `xvfb-run -a npm run test:integration` and `POLYLOG_VSCODE_VERSION=1.85.0 xvfb-run -a npm run test:integration`. Every new test is mutation-checked once (break the feature, see it fail, restore).
- Commits: `git add <files>` + `git commit` on `feat/uncommitted-view` only, local identity `lntvan166 <lntvan166@gmail.com>`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- vscode.git API v1 on 1.85 and stable has `Repository.add(paths)`, `revert(paths)`, `clean(paths)`, `commit(message, opts)`, `status()` (absolute fs paths); verified in `.vscode-test/*/resources/app/extensions/git/dist/main.js`.

## Review Focus

1. A file staged, then edited again: appears in Staged and Changes, each row opens its own diff (HEAD↔index, index↔file); staging the Changes row merges into one Staged row.
2. Discard on a group that includes untracked files: the confirmation names how many will be deleted; Cancel (or Escape) changes nothing; the files really go (git status from outside).
3. Commit with nothing staged: `git.enableSmartCommit` true commits all without asking; false asks; Cancel at any step commits nothing; a failing pre-commit hook shows git's message and leaves the staged files staged.
4. A repository vscode.git has not opened (nested deeper than its scan depth): listed, review only, no Stage/Discard/Commit buttons, no error.
5. Switching the Log to Uncommitted and back keeps the Commit list's filters, selection and scroll; the badge stays current while the Uncommitted view is collapsed.

Each line has its test in the owning task (Tasks 1, 3, 6, 6, 7).

---

### Task 1: Split git status into Staged and Changes

**Files:**
- Modify: `src/workingTree.ts`
- Test: `src/workingTree.test.ts`

**Interfaces:**
- Produces:
  - `interface WorkEntry { path: string; oldPath?: string; status: ChangeStatus; untracked?: boolean; conflicted?: boolean }`
  - `splitStatus(stdout: string): { staged: WorkEntry[]; changes: WorkEntry[] }`
  - `stagedNumstatArgs(head: string | null, pathspecs: readonly string[]): string[]`
  - `unstagedNumstatArgs(pathspecs: readonly string[]): string[]`
  - `workFiles(entries: readonly WorkEntry[], counts: ReadonlyMap<string, {added: number|null; deleted: number|null}>): FileChange[]`
  - keeps `statusArgs`, `headOf`, `parseNumstat`, `EMPTY_TREE`; removes `parseStatus`, `numstatArgs`, `uncommittedFiles` once Task 5 no longer uses them (Task 5 deletes them).

- [ ] **Step 1: Write the failing test** (append to `src/workingTree.test.ts`, reusing its `rec` and `H` helpers)

```ts
import { splitStatus, stagedNumstatArgs, unstagedNumstatArgs, workFiles } from "./workingTree";
{
  const out = [
    rec(".M", "src/app.ts"),          // changed, not staged
    rec("M.", "src/staged.ts"),       // fully staged
    rec("MM", "src/both.ts"),         // staged, then changed again
    rec("A.", "src/new.ts"),          // added to the index
    rec("AM", "src/newer.ts"),        // added, then changed again
    rec(".D", "old.txt"),             // deleted in the working tree
    rec("D.", "gone.txt"),            // git rm
    `2 R. N... 100644 100644 100644 ${H} ${H} R100 docs/b.md\0docs/a.md`,
    `2 RM N... 100644 100644 100644 ${H} ${H} R100 docs/d.md\0docs/c.md`,
    "? notes/todo café.md",
    `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict.ts`,
  ].join("\0") + "\0";
  const s = splitStatus(out);
  assert.deepStrictEqual(s.staged.map((e) => [e.path, e.status]), [
    ["src/staged.ts", "M"], ["src/both.ts", "M"], ["src/new.ts", "A"], ["src/newer.ts", "A"], ["gone.txt", "D"], ["docs/b.md", "R"], ["docs/d.md", "R"],
  ], "the index half: what a commit now would contain");
  assert.deepStrictEqual(s.changes.map((e) => [e.path, e.status]), [
    ["src/app.ts", "M"], ["src/both.ts", "M"], ["src/newer.ts", "M"], ["old.txt", "D"], ["docs/d.md", "M"], ["notes/todo café.md", "A"], ["conflict.ts", "M"],
  ], "the working-tree half, untracked and conflicted files included");
  assert.strictEqual(s.staged.find((e) => e.path === "docs/b.md")?.oldPath, "docs/a.md");
  assert.ok(s.changes.find((e) => e.path === "notes/todo café.md")?.untracked);
  assert.ok(s.changes.find((e) => e.path === "conflict.ts")?.conflicted);
  assert.deepStrictEqual(splitStatus(""), { staged: [], changes: [] });
  console.log("ok - git status splits into Staged (index) and Changes (working tree); a file can be in both");
}
{
  assert.deepStrictEqual(stagedNumstatArgs("a".repeat(40), [":(literal)src"]), ["diff", "--cached", "a".repeat(40), "--numstat", "-z", "-M", "--", ":(literal)src"]);
  assert.deepStrictEqual(stagedNumstatArgs(null, []).slice(0, 3), ["diff", "--cached", EMPTY_TREE], "no commit yet: against the empty tree");
  assert.deepStrictEqual(unstagedNumstatArgs([]), ["diff", "--numstat", "-z", "--"], "index ↔ working tree");
  const files = workFiles(splitStatus(rec(".M", "a.ts") + "\0? b.ts\0").changes, parseNumstat("3\t1\ta.ts\0"));
  assert.deepStrictEqual(files.map((f) => [f.path, f.added, f.deleted, f.status, f.untracked === true]), [["a.ts", 3, 1, "M", false], ["b.ts", 0, 0, "A", true]], "an untracked file counts 0/0: new, not binary");
  console.log("ok - Staged and Changes counts come from their own diffs");
}
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx esbuild src/workingTree.test.ts --bundle --platform=node --format=cjs --outfile=out/workingTree.test.cjs --log-level=error && node out/workingTree.test.cjs`
Expected: esbuild error `No matching export in "src/workingTree.ts" for import "splitStatus"`.

- [ ] **Step 3: Implement** (append to `src/workingTree.ts`)

```ts
/** One side of an uncommitted file: what is staged (index) or what is not yet (working tree). */
export interface WorkEntry {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  untracked?: boolean;
  conflicted?: boolean;
}

const letter = (c: string): ChangeStatus => (c === "A" ? "A" : c === "D" ? "D" : c === "T" ? "T" : "M");

/**
 * `git status --porcelain=v2 -z` as Source Control shows it: the index half (Staged) and the
 * working-tree half (Changes). A file staged and changed again is in both.
 */
export function splitStatus(stdout: string): { staged: WorkEntry[]; changes: WorkEntry[] } {
  const staged: WorkEntry[] = [];
  const changes: WorkEntry[] = [];
  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "" || t.startsWith("# ")) continue;
    const parts = t.split(" ");
    const kind = t[0];
    if (kind === "?") {
      changes.push({ path: t.slice(2), status: "A", untracked: true });
    } else if (kind === "1") {
      const [x, y] = parts[1];
      const path = parts.slice(8).join(" ");
      if (x !== ".") staged.push({ path, status: letter(x) });
      if (y !== ".") changes.push({ path, status: letter(y) });
    } else if (kind === "2") {
      const [x, y] = parts[1];
      const path = parts.slice(9).join(" ");
      const oldPath = tokens[++i];
      if (x !== ".") staged.push({ path, oldPath, status: x === "C" ? "C" : "R" });
      if (y !== ".") changes.push({ path, status: letter(y) });
    } else if (kind === "u") {
      changes.push({ path: parts.slice(10).join(" "), status: "M", conflicted: true });
    }
  }
  return { staged, changes };
}

/** +/- of what is staged: the index against the last commit (or the empty tree). */
export function stagedNumstatArgs(head: string | null, pathspecs: readonly string[]): string[] {
  return ["diff", "--cached", head ?? EMPTY_TREE, "--numstat", "-z", "-M", "--", ...pathspecs];
}

/** +/- of what is not staged: the working tree against the index. */
export function unstagedNumstatArgs(pathspecs: readonly string[]): string[] {
  return ["diff", "--numstat", "-z", "--", ...pathspecs];
}

/** One side's file list, with its counts. Untracked files count 0/0 (new, not binary). */
export function workFiles(entries: readonly WorkEntry[], counts: ReadonlyMap<string, { added: number | null; deleted: number | null }>): FileChange[] {
  return entries.map((e) => {
    const c = counts.get(e.path) ?? { added: 0, deleted: 0 };
    return { path: e.path, ...(e.oldPath ? { oldPath: e.oldPath } : {}), added: c.added, deleted: c.deleted, status: e.status, ...(e.untracked ? { untracked: true } : {}) };
  });
}
```

- [ ] **Step 4: Run, expect PASS**

Run: same command. Expected: every `ok - …` line, including the two new ones.

- [ ] **Step 5: Real git check** (append to the real-git uncommitted block in `src/git.test.ts`, which already builds a repo with `a.ts` modified, `b.ts` staged, `new.ts` added, `gone.ts` deleted, `old.md`→`new.md` renamed, an untracked file)

```ts
const split = splitStatus(await runGit(wt, statusArgs([])));
assert.deepStrictEqual(split.staged.map((e) => e.path).sort(), ["b.ts", "new.md", "new.ts"].sort());
const stagedCounts = parseNumstat(await runGit(wt, stagedNumstatArgs(head, [])));
assert.ok(stagedCounts.has("b.ts"), "git diff --cached counts the staged files");
console.log("ok - real git: Staged and Changes from status, counts from their own diffs");
```

Run: `npm test`. Expected: all ok. (Adjust the expected staged list to exactly what that block stages; read it first.)

- [ ] **Step 6: Commit**

```bash
npm run check:denylist && git add src/workingTree.ts src/workingTree.test.ts src/git.test.ts && git commit -m "feat: split git status into Staged and Changes, each with its own counts"
```

---

### Task 2: Index revisions (the staged version of a file)

**Files:**
- Modify: `src/revisionUri.ts`, `src/revisionProvider.ts`
- Test: `src/revisionUri.test.ts`

**Interfaces:**
- Produces: `INDEX = ":"`; `RevisionRef.ref` may be `":"`; `decodeRevision` accepts it; `RevisionProvider` serves it with `git show :<path>`.

- [ ] **Step 1: Failing test** (append to `src/revisionUri.test.ts`)

```ts
import { INDEX } from "./revisionUri";
{
  const r = { root: "/ws/acme-web", ref: INDEX, path: "src/app.ts" };
  const e = encodeRevision(r);
  assert.deepStrictEqual(decodeRevision(e.path, e.query), r, "the index (staged version) round-trips");
  assert.throws(() => decodeRevision("/a", JSON.stringify({ root: "/ws", ref: ":evil" })), "only the bare index marker");
  assert.strictEqual(workingFile(r, ["/ws/acme-web"]), "/ws/acme-web/src/app.ts".split("/").join(require("path").sep), "Open File works from a staged diff too");
  console.log("ok - an index revision (staged version) is a polylog: URI like any other");
}
```

(Use `path.resolve` for the expected working file, as the existing tests do, so it passes on Windows.)

- [ ] **Step 2: Run, expect FAIL** — `No matching export … "INDEX"`.

- [ ] **Step 3: Implement**

`src/revisionUri.ts`:
```ts
/** The index (staging area): `git show :<path>` is the staged version. */
export const INDEX = ":";
```
and in `decodeRevision` replace the ref check with
`!(q.ref === null || q.ref === INDEX || isSha(q.ref))`; update the `RevisionRef.ref` doc comment ("a commit id, INDEX for the staged version, or null for empty").

`src/revisionProvider.ts`: `const spec = rev.ref === INDEX ? `:${rev.path}` : `${rev.ref}:${rev.path}`;` (import `INDEX`). The existing `cat-file -e` fallback handles a path not in the index (shows empty).

- [ ] **Step 4: Run, expect PASS.** `npm test`.

- [ ] **Step 5: Commit**

```bash
npm run check:denylist && git add src/revisionUri.ts src/revisionProvider.ts src/revisionUri.test.ts && git commit -m "feat: polylog: URIs for the staged version of a file"
```

---

### Task 3: The uncommitted model (pure)

**Files:**
- Create: `src/uncommittedModel.ts`, `src/uncommittedModel.test.ts`
- Modify: `package.json` (append the test to `test:unit`)

**Interfaces:**
- Consumes: `FileChange`, `ChangeStatus` (types), `fileTree` (fileTree.ts), `decorationFor` (changesModel.ts).
- Produces:

```ts
export interface RepoWork {
  repoId: string; root: string; name: string;
  head: string | null;
  staged: FileChange[];   // index half
  changes: FileChange[];  // working-tree half
  editedAt: number | null; // ms, newest mtime of a changed file
  canStage: boolean;       // vscode.git has the repository open
}
export type Group = "staged" | "changes";
export type DiffSide = "head" | "index" | "worktree" | "empty";
export function distinctPaths(w: RepoWork): string[];
export function totals(works: readonly RepoWork[]): { files: number; repos: number; added: number; deleted: number };
export function meter(w: RepoWork): { added: number; modified: number; deleted: number };
export function tags(w: RepoWork): string[];
export function previewLabel(w: RepoWork): string;
export function editedLabel(nowMs: number, editedAt: number | null): string;
export function diffFor(group: Group, f: FileChange, alsoStaged: boolean): { left: DiffSide; right: DiffSide };
export function discardPrompt(repoName: string, files: readonly FileChange[], one: boolean): { message: string; detail: string; button: string };
export type CommitStep = "message" | "commitAll" | "askStageAll" | "nothing";
export function commitStep(staged: number, changes: number, smartCommit: boolean): CommitStep;
export interface UNode { kind: "repo" | "group" | "folder" | "file"; id: string; label: string; description: string; tooltip: string; contextValue: string; repoId: string; group?: Group; path?: string; file?: FileChange; children: UNode[] }
export function describeUncommitted(works: readonly RepoWork[]): { message: string | undefined; roots: UNode[] };
export const NO_UNCOMMITTED_VIEW = "No uncommitted changes in the ticked repositories.";
```

- [ ] **Step 1: Failing test** (`src/uncommittedModel.test.ts`)

```ts
import * as assert from "assert";
import { commitStep, describeUncommitted, diffFor, discardPrompt, distinctPaths, editedLabel, meter, NO_UNCOMMITTED_VIEW, previewLabel, tags, totals, type RepoWork } from "./uncommittedModel";
import type { FileChange } from "./types";

const f = (path: string, status: FileChange["status"], added = 1, deleted = 0, extra: Partial<FileChange> = {}): FileChange => ({ path, status, added, deleted, ...extra });
const web: RepoWork = {
  repoId: "/ws/acme-web", root: "/ws/acme-web", name: "acme-web", head: "a".repeat(40), editedAt: 1_000_000, canStage: true,
  staged: [f("notes.md", "M", 1, 0)],
  changes: [f("src/app.ts", "M", 3, 1), f("src/new.ts", "A", 0, 0, { untracked: true }), f("notes.md", "M", 2, 0)],
};
const api: RepoWork = { repoId: "/ws/acme-api", root: "/ws/acme-api", name: "acme-api", head: "b".repeat(40), editedAt: null, canStage: false, staged: [], changes: [f("upload/upload.go", "M", 2, 0)] };
const clean: RepoWork = { ...api, repoId: "/ws/acme-libs", name: "acme-libs", changes: [] };

{
  assert.deepStrictEqual(distinctPaths(web), ["notes.md", "src/app.ts", "src/new.ts"], "a file in both halves counts once");
  assert.deepStrictEqual(totals([web, api, clean]), { files: 4, repos: 2, added: 8, deleted: 1 }, "clean repositories do not count");
  assert.deepStrictEqual(meter(web), { added: 1, modified: 2, deleted: 0 });
  assert.deepStrictEqual(tags(web), ["1 staged", "1 new"]);
  assert.deepStrictEqual(tags({ ...web, changes: [] }), ["all staged"]);
  assert.strictEqual(previewLabel(web), "3 files · notes.md, src/app.ts, src/new.ts");
  assert.strictEqual(editedLabel(1_000_000 + 125_000, 1_000_000), "edited 2m ago");
  assert.strictEqual(editedLabel(5, null), "");
  console.log("ok - the Log's Uncommitted rows: distinct files, totals, meter, tags, preview, edited time");
}
{
  const staged = f("a.ts", "M"), added = f("n.ts", "A"), untracked = f("u.ts", "A", 0, 0, { untracked: true }), gone = f("g.ts", "D");
  assert.deepStrictEqual(diffFor("staged", staged, true), { left: "head", right: "index" });
  assert.deepStrictEqual(diffFor("staged", added, true), { left: "empty", right: "index" });
  assert.deepStrictEqual(diffFor("changes", staged, true), { left: "index", right: "worktree" }, "staged and changed again: index ↔ file");
  assert.deepStrictEqual(diffFor("changes", staged, false), { left: "head", right: "worktree" });
  assert.deepStrictEqual(diffFor("changes", untracked, false), { left: "empty", right: "worktree" });
  assert.deepStrictEqual(diffFor("changes", gone, false), { left: "head", right: "empty" });
  assert.deepStrictEqual(diffFor("staged", gone, true), { left: "head", right: "empty" });
  console.log("ok - each row opens the diff Source Control would");
}
{
  assert.deepStrictEqual(discardPrompt("acme-web", [f("src/app.ts", "M")], true), { message: 'Discard changes in "src/app.ts"?', detail: "This can't be undone.", button: "Discard File" });
  assert.deepStrictEqual(discardPrompt("acme-web", [f("src/new.ts", "A", 0, 0, { untracked: true })], true).detail, "This can't be undone. This deletes the new file.");
  assert.deepStrictEqual(discardPrompt("acme-web", web.changes, false), { message: "Discard changes in 3 files in acme-web?", detail: "This can't be undone. 1 new file will be deleted.", button: "Discard All" });
  assert.strictEqual(commitStep(1, 3, false), "message");
  assert.strictEqual(commitStep(0, 3, true), "commitAll", "git.enableSmartCommit: commit everything without asking");
  assert.strictEqual(commitStep(0, 3, false), "askStageAll");
  assert.strictEqual(commitStep(0, 0, false), "nothing");
  console.log("ok - Discard's confirmation and Commit's steps");
}
{
  const d = describeUncommitted([web, api, clean]);
  assert.strictEqual(d.message, undefined);
  assert.deepStrictEqual(d.roots.map((r) => [r.label, r.description, r.contextValue]), [["acme-web", "3 files", "repo.stageable"], ["acme-api", "1 file", "repo.readonly"]], "clean repositories are not listed; review only without vscode.git");
  const groups = d.roots[0].children;
  assert.deepStrictEqual(groups.map((g) => [g.label, g.description, g.contextValue]), [["Staged", "1", "group.staged"], ["Changes", "3", "group.changes"]]);
  const src = groups[1].children.find((n) => n.label === "src")!;
  assert.deepStrictEqual(src.children.map((n) => [n.label, n.description, n.contextValue]), [["app.ts", "+3 −1", "file.changes"], ["new.ts", "new", "file.changes.untracked"]]);
  assert.ok(d.roots[1].children[0].children[0].contextValue.endsWith(".readonly"), "no Stage/Discard on a repository vscode.git has not opened");
  assert.strictEqual(describeUncommitted([clean]).message, NO_UNCOMMITTED_VIEW);
  assert.strictEqual(new Set(JSON.stringify(d.roots).match(/"id":"[^"]+"/g)).size, JSON.stringify(d.roots).match(/"id":"[^"]+"/g)!.length, "ids are unique (the same path in both groups)");
  console.log("ok - the Uncommitted view: repositories, Staged/Changes groups, folders, files, read-only rows");
}
```

- [ ] **Step 2: Run, expect FAIL** — `Could not resolve "./uncommittedModel"`.

Run: `npx esbuild src/uncommittedModel.test.ts --bundle --platform=node --format=cjs --outfile=out/uncommittedModel.test.cjs --log-level=error && node out/uncommittedModel.test.cjs`

- [ ] **Step 3: Implement `src/uncommittedModel.ts`**

```ts
// Uncommitted work as the Log's switch and the Uncommitted view show it. Pure: no vscode import.
import { fileTree, type TreeNode } from "./fileTree";
import type { FileChange } from "./types";

export interface RepoWork {
  repoId: string;
  root: string;
  name: string;
  head: string | null;
  /** What a commit now would contain: the index against the last commit. */
  staged: FileChange[];
  /** What is not staged yet: the working tree against the index, untracked files included. */
  changes: FileChange[];
  /** Newest modification time (ms) of a changed file; null when unknown. */
  editedAt: number | null;
  /** VS Code's Git has the repository open: it can stage, discard and commit there. */
  canStage: boolean;
}
export type Group = "staged" | "changes";
export type DiffSide = "head" | "index" | "worktree" | "empty";
export const NO_UNCOMMITTED_VIEW = "No uncommitted changes in the ticked repositories.";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function distinctPaths(w: RepoWork): string[] {
  return [...new Set([...w.staged, ...w.changes].map((f) => f.path))].sort();
}

export function totals(works: readonly RepoWork[]): { files: number; repos: number; added: number; deleted: number } {
  let files = 0, repos = 0, added = 0, deleted = 0;
  for (const w of works) {
    const n = distinctPaths(w).length;
    if (n === 0) continue;
    repos++;
    files += n;
    for (const f of [...w.staged, ...w.changes]) { added += f.added ?? 0; deleted += f.deleted ?? 0; }
  }
  return { files, repos, added, deleted };
}

/** Distinct files by kind: new (added or untracked), deleted, modified (the rest). */
export function meter(w: RepoWork): { added: number; modified: number; deleted: number } {
  const kind = new Map<string, "added" | "modified" | "deleted">();
  for (const f of [...w.staged, ...w.changes]) {
    const k = f.status === "A" || f.untracked ? "added" : f.status === "D" ? "deleted" : "modified";
    if (!kind.has(f.path) || k !== "modified") kind.set(f.path, k);
  }
  const out = { added: 0, modified: 0, deleted: 0 };
  for (const k of kind.values()) out[k]++;
  return out;
}

export function tags(w: RepoWork): string[] {
  const out: string[] = [];
  if (w.staged.length > 0) out.push(w.changes.length === 0 ? "all staged" : `${w.staged.length} staged`);
  const news = w.changes.filter((f) => f.untracked).length;
  if (news > 0) out.push(`${news} new`);
  return out;
}

export function previewLabel(w: RepoWork): string {
  const paths = distinctPaths(w);
  return `${plural(paths.length, "file")} · ${paths.join(", ")}`;
}

export function editedLabel(nowMs: number, editedAt: number | null): string {
  if (editedAt === null) return "";
  const m = Math.floor((nowMs - editedAt) / 60_000);
  return m < 1 ? "edited just now" : m < 60 ? `edited ${m}m ago` : m < 48 * 60 ? `edited ${Math.floor(m / 60)}h ago` : `edited ${Math.floor(m / 1440)}d ago`;
}

/** The diff a row opens, as Source Control: Staged is HEAD ↔ index; Changes is index (or HEAD) ↔ file. */
export function diffFor(group: Group, f: FileChange, alsoStaged: boolean): { left: DiffSide; right: DiffSide } {
  const isNew = f.status === "A" || f.untracked === true;
  if (group === "staged") return { left: isNew ? "empty" : "head", right: f.status === "D" ? "empty" : "index" };
  if (f.untracked) return { left: "empty", right: "worktree" };
  return { left: alsoStaged ? "index" : "head", right: f.status === "D" ? "empty" : "worktree" };
}

export function discardPrompt(repoName: string, files: readonly FileChange[], one: boolean): { message: string; detail: string; button: string } {
  const news = files.filter((f) => f.untracked).length;
  const message = one ? `Discard changes in "${files[0].path}"?` : `Discard changes in ${plural(files.length, "file")} in ${repoName}?`;
  const extra = news === 0 ? "" : one || news === files.length ? (news === 1 ? " This deletes the new file." : " This deletes the new files.") : ` ${plural(news, "new file")} will be deleted.`;
  return { message, detail: `This can't be undone.${extra}`, button: one ? "Discard File" : "Discard All" };
}

export type CommitStep = "message" | "commitAll" | "askStageAll" | "nothing";
export function commitStep(staged: number, changes: number, smartCommit: boolean): CommitStep {
  if (staged > 0) return "message";
  if (changes === 0) return "nothing";
  return smartCommit ? "commitAll" : "askStageAll";
}

export interface UNode {
  kind: "repo" | "group" | "folder" | "file";
  /** Stable across re-renders so VS Code keeps expand state. */
  id: string;
  label: string;
  description: string;
  tooltip: string;
  /** Menus key off it: repo.stageable|readonly, group.staged|changes[.readonly], file.staged|changes[.untracked][.readonly]. */
  contextValue: string;
  repoId: string;
  group?: Group;
  path?: string;
  file?: FileChange;
  children: UNode[];
}

function fileStat(f: FileChange): string {
  if (f.untracked) return "new";
  if (f.added === null) return "binary";
  const counts = `+${f.added} −${f.deleted}`;
  return f.oldPath ? `← ${f.oldPath}  ${counts}` : counts;
}

function describeTree(nodes: readonly TreeNode[], parent: string, base: string, w: RepoWork, group: Group): UNode[] {
  const ro = w.canStage ? "" : ".readonly";
  return nodes.map((n): UNode => {
    if (n.kind === "folder") {
      const path = parent ? `${parent}/${n.name}` : n.name;
      return { kind: "folder", id: `${base}/d:${path}`, label: n.name, description: String(n.count), tooltip: path, contextValue: "folder", repoId: w.repoId, group, path, children: describeTree(n.children, path, base, w, group) };
    }
    const f = n.file;
    return {
      kind: "file", id: `${base}/f:${f.path}`, label: n.name, description: fileStat(f), tooltip: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path,
      contextValue: `file.${group}${f.untracked ? ".untracked" : ""}${ro}`, repoId: w.repoId, group, path: f.path, file: f, children: [],
    };
  });
}

export function describeUncommitted(works: readonly RepoWork[]): { message: string | undefined; roots: UNode[] } {
  const roots = works.filter((w) => distinctPaths(w).length > 0).map((w): UNode => {
    const ro = w.canStage ? "" : ".readonly";
    const groups: UNode[] = [];
    for (const [group, list, label] of [["staged", w.staged, "Staged"], ["changes", w.changes, "Changes"]] as const) {
      if (list.length === 0) continue;
      const id = `${w.repoId}/${group}`;
      groups.push({ kind: "group", id, label, description: String(list.length), tooltip: `${label} in ${w.name}`, contextValue: `group.${group}${ro}`, repoId: w.repoId, group, children: describeTree(fileTree(list), "", id, w, group) });
    }
    const n = distinctPaths(w).length;
    return {
      kind: "repo", id: w.repoId, label: w.name, description: plural(n, "file"),
      tooltip: w.canStage ? `${w.name}: uncommitted changes` : `${w.name}: staging needs VS Code's Git to have this repository open.`,
      contextValue: w.canStage ? "repo.stageable" : "repo.readonly", repoId: w.repoId, children: groups,
    };
  });
  return { message: roots.length === 0 ? NO_UNCOMMITTED_VIEW : undefined, roots };
}
```

- [ ] **Step 4: Run, expect PASS**; then append `&& esbuild src/uncommittedModel.test.ts --bundle --platform=node --format=cjs --outfile=out/uncommittedModel.test.cjs && node out/uncommittedModel.test.cjs` to `test:unit` and run `npm test` (all ok).

- [ ] **Step 5: Commit**

```bash
npm run check:denylist && git add src/uncommittedModel.ts src/uncommittedModel.test.ts package.json && git commit -m "feat: the uncommitted model: rows, groups, diffs, Discard and Commit steps"
```

---

### Task 4: Stage, unstage, discard and commit through VS Code's Git

**Files:**
- Modify: `src/repoDiscovery.ts`

**Interfaces:**
- Produces on `RepoDiscovery`:
  - `stage(root: string, paths: string[]): Promise<void>` (`add`), `unstage(root, paths)` (`revert`), `discard(root, paths)` (`clean`), `commit(root: string, message: string, all: boolean): Promise<void>`.
  - Each looks the repository up with the existing `vsCodeGitRepo(root)` (exact root), calls `status()` first (its view may lag a terminal change), throws `Error("VS Code's Git does not have this repository open")` when missing. Paths are absolute (`path.join(root, ...rel.split("/"))`).
- Extend the `GitRepository` interface: `add?(paths: string[]): Promise<void>; revert?(paths: string[]): Promise<void>; clean?(paths: string[]): Promise<void>; commit?(message: string, opts?: { all?: boolean }): Promise<void>;`.

- [ ] **Step 1: Implement** (no unit test: vscode-only; the integration tests in Task 6 cover every method end to end)

```ts
  private async gitRepoFor(root: string): Promise<GitRepository & Required<Pick<GitRepository, "status">>> {
    const repo = this.vsCodeGitRepo(root);
    if (!repo || typeof repo.status !== "function") throw new Error("VS Code's Git does not have this repository open");
    await repo.status();
    return repo as GitRepository & Required<Pick<GitRepository, "status">>;
  }
  private abs(root: string, paths: readonly string[]): string[] {
    return paths.map((p) => path.join(root, ...p.split("/")));
  }
  async stage(root: string, paths: string[]): Promise<void> { const r = await this.gitRepoFor(root); await r.add!(this.abs(root, paths)); }
  async unstage(root: string, paths: string[]): Promise<void> { const r = await this.gitRepoFor(root); await r.revert!(this.abs(root, paths)); }
  async discard(root: string, paths: string[]): Promise<void> { const r = await this.gitRepoFor(root); await r.clean!(this.abs(root, paths)); }
  async commit(root: string, message: string, all: boolean): Promise<void> { const r = await this.gitRepoFor(root); await r.commit!(message, all ? { all: true } : undefined); }
```

- [ ] **Step 2: Typecheck** — `npm run typecheck` (0 errors).

- [ ] **Step 3: Commit**

```bash
npm run check:denylist && git add src/repoDiscovery.ts && git commit -m "feat: stage, unstage, discard and commit through VS Code's Git API"
```

---

### Task 5: The uncommitted store (move reads out of the Log)

**Files:**
- Create: `src/uncommittedStore.ts`
- Modify: `src/logView.ts`, `src/extension.ts`, `src/workingTree.ts` (delete `parseStatus`, `numstatArgs`, `uncommittedFiles` and their tests), `src/workingTree.test.ts`, `src/git.test.ts`

**Interfaces:**
- Consumes: `splitStatus`, `stagedNumstatArgs`, `unstagedNumstatArgs`, `workFiles`, `statusArgs`, `headOf`, `parseNumstat` (Task 1); `RepoWork` (Task 3); `RepoDiscovery.reportsChanges`, `vsCodeGitHas`.
- Produces:

```ts
export interface Scope { repos: readonly Repo[]; pathspecs: readonly string[] } // repos = the ticked ones, in Repo List order
export class UncommittedStore implements vscode.Disposable {
  constructor(deps: { run: RunGit; discovery: RepoDiscovery; concurrency: () => number });
  readonly onDidChange: vscode.Event<void>;
  setScope(scope: Scope): void;            // a new scope reads every repository of it (unless identical, see below)
  readAll(force?: boolean): Promise<void>; // force: Refresh, a new git binary
  touch(fsPath: string): void;             // a save or a VS Code Git report: re-read that repository (400 ms burst)
  readRepo(repoId: string): Promise<void>; // after Stage/Unstage/Discard/Commit
  works(): RepoWork[];                     // scope order; repositories not read yet are absent
  get(repoId: string): RepoWork | undefined;
  readonly known: boolean;                 // the first full read finished (the badge shows a number)
  snapshotSpawns?: never;
}
```

The store carries over, unchanged in behaviour, from `logView.ts`: `Working`→`RepoWork` map, `uncommittedSeq` ordering, `uncommittedRead`/`repoReads` controllers, `touched` + `touchedSoon` (400 ms), `uncommittedDone`/`uncommittedInFlight`/`uncommittedReading` (skip identical full reads; repositories `reportsChanges` false are read on every full read), `uncommittedSpec`. New: each repository read runs `statusArgs`, then for a dirty repo `stagedNumstatArgs` and `unstagedNumstatArgs` in parallel, `splitStatus` + `workFiles`, and `fs.promises.stat` for up to 50 non-deleted changed files (newest mtime → `editedAt`; failures ignored). `canStage = discovery.vsCodeGitHas(root)`. `onDidChange` fires (coalesced per 80 ms, as `publishUncommittedSoon` did) only when a repository's `RepoWork` differs (`sameWorking` extended to both halves).

- [ ] **Step 1: Move the integration tests first** — in `src/integration/log.itest.ts`, the test "uncommitted changes: pinned above the commits when the toggle is on, and they follow a save" becomes "the uncommitted store follows saves and git events, one repository at a time": replace every pinned-row assertion (`x.rows[0]?.sha === UNCOMMITTED`, `uncommitted === N`) with the new snapshot seam `x.uncommitted` (Task 5 adds `uncommitted: { repoId: string; staged: string[]; changes: string[] }[]` to `LogSnapshot`, from `store.works()`), and drop the toggle (`cfg.update("showUncommitted", …)`, `polylog.showUncommitted/hideUncommitted`) since the store reads after the first page. Keep: a save re-reads only its own repository; a no-op save posts nothing (`posts.uncommitted` count unchanged); a save outside every repository reads nothing; a date change does not re-read reported repositories; Refresh reads again; `git.autorefresh` off reads every repository. Run integration: expect FAIL (`uncommitted` is undefined on the snapshot).

- [ ] **Step 2: Create `src/uncommittedStore.ts`** by moving `readUncommitted`, `hasPinned`→removed, `publishUncommittedSoon`→`changedSoon`, `workingTreeChanged`→`touch`, `uncommittedChanged`→`readSome`, `forgetUncommittedRead`, `sameWorking`, and the related fields from `src/logView.ts` (cut, then adapt names). The repository read becomes:

```ts
  private async readOne(r: Repo, specs: readonly string[], signal: AbortSignal): Promise<RepoWork> {
    const out = await this.deps.run(r.root, statusArgs(specs), signal);
    const head = headOf(out);
    const split = splitStatus(out);
    let staged: FileChange[] = [], changes: FileChange[] = [];
    if (split.staged.length + split.changes.length > 0) {
      const [s, u] = await Promise.all([
        split.staged.length ? this.deps.run(r.root, stagedNumstatArgs(head, specs), signal) : Promise.resolve(""),
        split.changes.length ? this.deps.run(r.root, unstagedNumstatArgs(specs), signal) : Promise.resolve(""),
      ]);
      staged = workFiles(split.staged, parseNumstat(s));
      changes = workFiles(split.changes, parseNumstat(u));
    }
    const editedAt = await newestMtime(r.root, [...staged, ...changes].filter((f) => f.status !== "D").slice(0, 50).map((f) => f.path));
    return { repoId: r.id, root: r.root, name: r.name, head, staged, changes, editedAt, canStage: this.deps.discovery.vsCodeGitHas(r.root) };
  }
```

with `newestMtime` = `Promise.allSettled(paths.map(p => fs.promises.stat(path.join(root, ...p.split("/")))))` → max `mtimeMs` or null.

- [ ] **Step 3: LogView consumes the store** — `LogDeps` gains `uncommitted: UncommittedStore`. Delete from `logView.ts`: the moved members; `uncommittedPref`, `uncommittedApplied`, `uncommittedOn`, `setUncommittedOn`, `uncommittedSettingChanged`, `uncommittedToggled`, `uncommittedShown`, `pinnedRows`, `shownRows` (callers use `this.rows`), `publishUncommitted`, `reviewUncommitted`, `leaveReview`, `showReviewTree`, `reviewSummary`, `review`, `reviewRepo`, the `exitReview` case, and `review` in `postInit`/snapshot. `reload()` no longer reads uncommitted work; after `setScope` changes (repos loaded, filter's `repoIds` or `path` changed) call `this.deps.uncommitted.setScope({ repos: selectRepos(this.filter, this.repos), pathspecs })`; `startBackgroundReads` calls `void this.deps.uncommitted.readAll()`; `refresh` calls `readAll(true)`; `gitChanged` calls `readAll(true)`. `openWorkingDiff` reads from `this.deps.uncommitted.get(repo.id)` (Task 7 replaces its sides with `diffFor`). Remove `pinned` from `HostMessage`, `withPinned` from `webview/view.ts` and its test, the `pinned` case and `mode-review` handling from `webview/main.ts`, `reviewLabel` and `emptyState`'s `review` from `view.ts` (+ tests).

- [ ] **Step 4: Extension wiring** — `extension.ts` builds `const uncommitted = new UncommittedStore({ run: git.run, discovery, concurrency: () => readSettings(...).maxConcurrency })` (spawn counting: the store's `run` is LogView's counted wrapper, exposed as `log.countedRun`, so `snapshot().spawnLog` keeps showing every git process), passes it to `LogView`, routes `onDidSaveTextDocument` → `uncommitted.touch(doc.uri.fsPath)`, `repoStateChanged(root)` → `uncommitted.touch(root)` (LogView keeps the sync part). Remove the `polylog.showUncommitted`/`hideUncommitted`/`reviewUncommitted` commands and the `polylog.showUncommitted` configuration listener. `package.json`: remove those three commands, their `view/title` and `commandPalette` entries, the `polylog.showUncommitted` setting.

- [ ] **Step 5: Run unit + integration** — `npm test && xvfb-run -a npm run test:integration`. Expected: all pass, including the moved test. Mutation check: make `touch` add every repository → the "a save re-reads only its own repository" assertion fails; restore.

- [ ] **Step 6: Delete dead code** — `parseStatus`, `numstatArgs`, `uncommittedFiles` and their tests (now unused); `npm run typecheck && npm test`.

- [ ] **Step 7: Commit**

```bash
npm run check:denylist && git add -A src package.json && git status --short && git commit -m "refactor: an uncommitted store, read after the first page; the Log loses pinned rows, the eye and Review mode"
```

(`git add -A src package.json` only after checking `git status --short` lists nothing outside them.)

---

### Task 6: The Uncommitted view

**Files:**
- Create: `src/uncommittedView.ts`
- Modify: `src/extension.ts`, `src/logView.ts` (`openWorkingDiff` uses `diffFor`), `package.json`
- Test: `src/integration/log.itest.ts`

**Interfaces:**
- Consumes: `UncommittedStore` (Task 5), `describeUncommitted`, `diffFor`, `discardPrompt`, `commitStep` (Task 3), `RepoDiscovery.stage/unstage/discard/commit` (Task 4), `INDEX` (Task 2).
- Produces: view id `polylog.uncommitted`; commands `polylog.focusUncommitted`, `polylog.refreshUncommitted`, `polylog.uncommittedCollapseAll`, `polylog.stage`, `polylog.unstage`, `polylog.discard`, `polylog.commitRepo`, `polylog.openUncommittedDiff`; test seam `polylog._itest.uncommitted` → `{ message?: string; items: string[] }` (same `label | description` walk as `ChangesSnapshot.items`).

- [ ] **Step 1: Failing integration test** (new `it` in `log.itest.ts`): with acme-web having `client.ts` modified, `notes.md` untracked and `extra.ts` staged (`git add`):
  1. `polylog.focusUncommitted`; wait for the seam to list `acme-web | 3 files` with `Staged | 1` and `Changes | 2`.
  2. `polylog.stage` with `{ repoId: web.id, group: "changes", path: "client.ts" }` → `git diff --cached --name-only` (run from outside) contains `client.ts`; the seam's Staged count is 2.
  3. `polylog.unstage` with the same file → back to Changes.
  4. `polylog.discard` with `notes.md`: stub `vscode.window.showWarningMessage` via the seam command `polylog._itest.answer` (`"Cancel"` then `"Discard File"`): Cancel leaves `notes.md` on disk; Discard File deletes it.
  5. `polylog.commitRepo` with `{ repoId: web.id }`: answer the input box with `polylog._itest.answer("feat: commit from the view")` → `git log -1 --format=%s` is that message; the Log's first row has that subject; the seam no longer lists acme-web (after `extra.ts` and `client.ts` were committed, nothing left).
  6. Nothing staged + `git.enableSmartCommit` false: `commitRepo` asks (answer `"Cancel"`) and commits nothing.
  7. The seam's repo rows end with their `contextValue` (`acme-web | 3 files [repo.stageable]`): assert it for acme-web. The read-only case (Review Focus 4) is pinned by the model test in Task 3, since every fixture repository is opened by vscode.git.
  Run: expect FAIL (`command 'polylog.focusUncommitted' not found`).

  The answer seam: `polylog._itest.answer(value)` queues one answer that `UncommittedView`'s `ask` helper returns instead of calling `showWarningMessage`/`showInputBox` when `POLYLOG_ITEST === "1"`. The helper is the only place that calls those two APIs.

- [ ] **Step 2: Implement `src/uncommittedView.ts`** — a `TreeDataProvider<UNode>` over `describeUncommitted(store.works())`, re-rendered on `store.onDidChange` (fire `undefined`), `view.message` from the model, `getTreeItem`: repo → `ThemeIcon("repo", new ThemeColor(<repo accent charts.* id>))` expanded; group → expanded; folder → `ThemeIcon.Folder`, expanded; file → `resourceUri` on the private `polylog-tree` scheme (as `ChangesTree`, query `uncommitted:<repoId>:<group>`) with a `FileDecoration` from `decorationFor(f.untracked ? "A" : f.status)`, command `polylog.openUncommittedDiff` with `{ repoId, group, path }`. `contextValue` from the model. Actions:
  - `stage/unstage/discard(node | args)`: resolve `{ repoId, group, path? }` (a group node means all its files), call `discovery.stage/unstage/discard`, then `store.readRepo(repoId)`; errors → `showErrorMessage("Polylog could not <verb> <file|N files> in <repo>: <message>.")`.
  - `discard`: `discardPrompt` → `ask.warning(message, detail, button)`; anything but `button` returns.
  - `commitRepo({ repoId })`: `commitStep(staged, changes, git.enableSmartCommit)`; `askStageAll` → `ask.warning("There are no staged changes in <repo>.", "Stage all changes and commit them?", "Stage All and Commit")`; message via `ask.input({ prompt: "Commit message for <repo>", placeHolder: "Message (<n> files staged)" })`; empty/undefined returns; `discovery.commit(root, message, all)`; then `store.readRepo`, and the Log reloads (`log.reloadSoon` exposed as `log.commitsChanged()`).
  - `openUncommittedDiff({ repoId, group, path })`: `diffFor(group, file, alsoStaged)` → URIs: `head` = `polylog:` with `ref: work.head` (empty when null), `index` = `ref: INDEX`, `worktree` = `vscode.Uri.file(abs)`, `empty` = `ref: null`; title `"<name> (Index) — <repo>"` for Staged, `"<name> (Working Tree) — <repo>"` for Changes; `vscode.diff` with `{ preview: true }`.
  - The Log's `openWorkingDiff` (the Changes view in the switch's review, Task 7) calls the same function with `group = staged.has(path) && !changes.has(path) ? "staged" : "changes"`.

- [ ] **Step 3: `package.json`**

```json
"views": { "polylog": [
  { "type": "webview", "id": "polylog.log", "name": "Log", "initialSize": 1100 },
  { "id": "polylog.changes", "name": "Changes", "initialSize": 450 },
  { "id": "polylog.uncommitted", "name": "Uncommitted", "initialSize": 450, "visibility": "collapsed" }
] }
```

Commands with icons: `polylog.stage` `$(add)` "Stage Changes", `polylog.unstage` `$(remove)` "Unstage Changes", `polylog.discard` `$(discard)` "Discard Changes", `polylog.commitRepo` `$(check)` "Commit…", `polylog.refreshUncommitted` `$(refresh)`, `polylog.uncommittedCollapseAll` `$(collapse-all)`, `polylog.focusUncommitted` "Focus Uncommitted". Menus:
- `view/title` (`view == polylog.uncommitted`): refresh `navigation@1`, collapse `navigation@2`.
- `view/item/context` inline (`group: "inline"`): `commitRepo` when `viewItem == repo.stageable`; `stage` + `discard` when `viewItem =~ /^(group|file)\.changes(\.untracked)?$/`; `unstage` when `viewItem =~ /^(group|file)\.staged$/`. Same three in the context menu (`group: "1_modification"`), plus Open File and File History for `viewItem =~ /^file\./`, and the Repo menu commands for `viewItem =~ /^repo\./` (they take `{ repoId }`).
- `commandPalette`: hide all item commands (`when: false`); keep `focusUncommitted` and `refreshUncommitted`.

- [ ] **Step 4: Run, expect PASS** (unit + integration stable + 1.85). Mutation checks: (a) `stage` calls `unstage`'s API → step 2 fails; (b) `discard` skips the prompt → the Cancel case fails; restore each.

- [ ] **Step 5: Commit**

```bash
npm run check:denylist && git add src/uncommittedView.ts src/extension.ts src/logView.ts package.json src/integration/log.itest.ts && git commit -m "feat: the Uncommitted view: Staged and Changes, stage, unstage, discard, commit"
```

---

### Task 7: The Log's Commits | Uncommitted switch

**Files:**
- Modify: `src/protocol.ts`, `src/logView.ts`, `src/webview/main.ts`, `src/webview/list.ts` (or create `src/webview/workList.ts`), `src/webview/view.ts`, `src/webview/view.test.ts`, `src/webview/styles.css`, `src/webview/html.ts`, `dev/harness/shim.ts`, `src/changesModel.ts` (+ test)
- Test: `src/webview/view.test.ts`, `src/integration/log.itest.ts`

**Interfaces:**
- Produces:
  - `HostMessage` `{ type: "uncommitted"; known: boolean; totals: { files; repos; added; deleted }; rows: WorkRow[] }` with `WorkRow = { repoId: string; preview: string; meter: { added; modified; deleted }; tags: string[]; editedAt: number | null }` (sorted most recently edited first; `editedAt` null last).
  - `WebviewMessage` `{ type: "logMode"; mode: "commits" | "uncommitted" }` and `{ type: "selectWork"; repoId: string }`.
  - `view.ts`: `switchCount(known: boolean, files: number): string` (`""` unless known and > 0), `totalsLabel(t): string` ("3 repositories · +24 −5"), `meterParts(m): { kind: "added"|"modified"|"deleted"; share: number }[]`.
  - `LogSnapshot.logMode`, `LogSnapshot.workRows: string[]` (each row's text, test seam).

- [ ] **Step 1: Failing unit tests** (`view.test.ts`)

```ts
assert.strictEqual(switchCount(false, 5), "", "not read yet: no number");
assert.strictEqual(switchCount(true, 0), "", "nothing uncommitted: no badge");
assert.strictEqual(switchCount(true, 6), "6");
assert.strictEqual(totalsLabel({ files: 6, repos: 3, added: 24, deleted: 5 }), "3 repositories · +24 −5");
assert.strictEqual(totalsLabel({ files: 1, repos: 1, added: 2, deleted: 0 }), "1 repository · +2 −0");
assert.deepStrictEqual(meterParts({ added: 1, modified: 2, deleted: 1 }).map((p) => [p.kind, p.share]), [["added", 0.25], ["modified", 0.5], ["deleted", 0.25]]);
assert.deepStrictEqual(meterParts({ added: 0, modified: 3, deleted: 0 }).map((p) => p.kind), ["modified"], "empty kinds are left out");
console.log("ok - the switch's badge, totals and change meter");
```

Run unit: expect FAIL (missing exports). Implement the three pure functions in `view.ts`; PASS.

- [ ] **Step 2: Failing integration test** — with acme-web and acme-api dirty: after the first page, `snapshot().workRows` lists both (most recently edited first) and the webview badge count is in the last `uncommitted` post (`posts.uncommitted.count > 0`, the message `known: true`, `totals.files` right); `send({ type: "logMode", mode: "uncommitted" })` then `send({ type: "selectWork", repoId: api.id })` → `changes.items[0]` is `acme-api | 1 file · not committed`; `send({ type: "logMode", mode: "commits" })` → rows and `filter` are exactly as before the switch (Review Focus 5). Expect FAIL.

- [ ] **Step 3: Host** — `LogView` keeps `logMode` (default `"commits"`, not persisted) and `workRepo`. On `store.onDidChange`, on first page and on `ready`, post `uncommitted` (built from `store.works()` with Task 3's helpers). `logMode` message switches; in `"uncommitted"` the Changes view shows `{ commit: pseudo-commit sha UNCOMMITTED for workRepo, files: union of staged+changes with `staged` flag for "· staged", status "ready" }` (the existing `pending` path of `describeChanges`), updated on store changes; `selectWork` sets `workRepo`. Changes view's `Review groups (`ChangesState.groups`, `ChangesGroup`, the groups branch of `describeChanges`, `NO_UNCOMMITTED`) are removed with their tests. The "review only" hint goes in the root's tooltip and description: "3 files · not committed · stage in the Uncommitted view", unit-tested in `changesModel.test.ts`.

- [ ] **Step 4: Webview** — the switch (`role="tablist"`, two `role="tab"` buttons, ←/→ move, `aria-selected`), above the Filter bar; totals on its right in Uncommitted. In Uncommitted, hide every Filter bar box but Path (`.filters` gets a `work` class; CSS hides `#search, #author-field, #branch, #date`), hide Load more and the commit count, render `WorkRow`s in the list area with the same virtual-list container (`CommitList` gains a `mode` prop or a sibling `WorkList` class — keep the list keyboard model: ↑/↓ select, Enter opens the first file). CSS uses only `--vscode-*` (meter colors: `--vscode-gitDecoration-addedResourceForeground`, `…modifiedResourceForeground`, `…deletedResourceForeground`; tags: `--vscode-badge-*`/`--vscode-gitDecoration-*`). Empty state: "Nothing uncommitted in the ticked repositories." Update `dev/harness/shim.ts` with sample `uncommitted` posts and a `?state=uncommitted` scenario.

- [ ] **Step 5: Run, expect PASS** (unit, integration ×2, `check:theme`, `check:design`); browser harness check in dark, light, HC (one screenshot each, `npm run harness`). Mutation: post `known: false` always → the badge test fails; restore.

- [ ] **Step 6: Commit**

```bash
npm run check:denylist && git add src/protocol.ts src/logView.ts src/webview src/changesModel.ts src/changesModel.test.ts dev/harness/shim.ts src/integration/log.itest.ts && git commit -m "feat: the Log's Commits | Uncommitted switch, with a badge and review rows"
```

---

### Task 8: All Files in the Changes view

**Files:**
- Create: `src/allFiles.ts`, `src/allFiles.test.ts`
- Modify: `src/changesTree.ts`, `src/extension.ts`, `src/logView.ts` (supplies the tree reader), `package.json`
- Test: `src/allFiles.test.ts`, `src/integration/log.itest.ts`

**Interfaces:**
- Produces (`allFiles.ts`, pure):
  - `lsTreeArgs(sha: string, dir: string): string[]` → `["ls-tree", "-z", sha, "--", dir === "" ? "." : `${dir}/`]` — note: `git ls-tree <sha> -- <dir>/` lists the folder's entries with full paths.
  - `parseLsTree(stdout: string): { path: string; kind: "folder" | "file" }[]` (`tree` → folder; `blob` and `commit` (submodule) → file).
  - `mergeLevel(dir: string, listed: readonly {path; kind}[], changed: readonly FileChange[]): { folders: { path: string; name: string; changedCount: number }[]; files: { path: string; name: string; change?: FileChange }[] }` — folders first then files, A→Z; deleted changed files whose parent is `dir` are added; `changedCount` counts changed files (deleted included) under each folder.
- `ChangesTree` gains `allFiles: boolean` (from `globalState` `polylog.changesAllFiles`), `setAllFiles(on)`, and a `listTree: (repoRoot: string, sha: string, dir: string, signal: AbortSignal) => Promise<string>` dependency. In All Files mode, `getChildren(folder)` is async and reads only that folder; folder nodes with `changedCount > 0` are `Expanded`, others `Collapsed`; unchanged files open via `polylog.openRevision { repoId, sha, path }` (read-only `polylog:` URI, title `"<name> (<sha7>)"`). A new `set(state)` aborts reads still running.

- [ ] **Step 1: Failing unit test** (`src/allFiles.test.ts`)

```ts
import * as assert from "assert";
import { lsTreeArgs, mergeLevel, parseLsTree } from "./allFiles";
const H = "e".repeat(40);
{
  assert.deepStrictEqual(lsTreeArgs(H, ""), ["ls-tree", "-z", H, "--", "."]);
  assert.deepStrictEqual(lsTreeArgs(H, "src/checkout"), ["ls-tree", "-z", H, "--", "src/checkout/"]);
  const out = `040000 tree ${H}\tsrc\0100644 blob ${H}\tREADME.md\0160000 commit ${H}\tvendor/lib\0100755 blob ${H}\tbin/run sh\0`;
  assert.deepStrictEqual(parseLsTree(out), [{ path: "src", kind: "folder" }, { path: "README.md", kind: "file" }, { path: "vendor/lib", kind: "file" }, { path: "bin/run sh", kind: "file" }], "folders, files, submodules as files, spaces kept");
  console.log("ok - git ls-tree: one folder's entries");
}
{
  const listed = [{ path: "src/checkout/PaymentStep.tsx", kind: "file" as const }, { path: "src/checkout/Summary.tsx", kind: "file" as const }, { path: "src/checkout/SavedCards.tsx", kind: "file" as const }];
  const changed = [
    { path: "src/checkout/PaymentStep.tsx", status: "M" as const, added: 11, deleted: 1 },
    { path: "src/checkout/SavedCards.tsx", status: "A" as const, added: 25, deleted: 0 },
    { path: "src/checkout/OldCards.tsx", status: "D" as const, added: 0, deleted: 31 },
    { path: "src/client.ts", status: "M" as const, added: 2, deleted: 0 },
  ];
  const level = mergeLevel("src/checkout", listed, changed);
  assert.deepStrictEqual(level.files.map((f) => [f.name, f.change?.status ?? ""]), [["OldCards.tsx", "D"], ["PaymentStep.tsx", "M"], ["SavedCards.tsx", "A"], ["Summary.tsx", ""]], "a deleted file is listed where it was; unchanged files plain");
  const top = mergeLevel("", [{ path: "src", kind: "folder" }, { path: "docs", kind: "folder" }, { path: "README.md", kind: "file" }], changed);
  assert.deepStrictEqual(top.folders.map((f) => [f.name, f.changedCount]), [["docs", 0], ["src", 4]], "folders A→Z; changes counted inside, deleted included");
  assert.deepStrictEqual(top.files.map((f) => f.name), ["README.md"]);
  console.log("ok - All Files: one folder's listing merged with the commit's changes");
}
```

Run: expect FAIL (`Could not resolve "./allFiles"`). Implement; PASS; append to `test:unit`.

- [ ] **Step 2: Failing integration test** — select the fixture commit that changes `client.ts` in acme-web; `polylog.changesShowAll`; the Changes snapshot lists unchanged files of that commit's tree (e.g. `README.md` if present in the fixture — read `src/integration/fixture.ts` first and pick a file it creates), keeps the changed file with its counts, lists a deleted file if the fixture has one (else add a fixture commit that deletes a file in a throwaway branch of the test); opening an unchanged file opens a `polylog:` document whose text equals `git show <sha>:<path>`; the spawn log shows one `ls-tree` per expanded folder (expanding one more folder adds exactly one). `polylog.changesShowChanged` restores the changed-files tree. Expect FAIL.

- [ ] **Step 3: Implement** in `changesTree.ts` (async `getChildren` for All Files; `TreeItemCollapsibleState` per `changedCount`; the commit header node stays first), `extension.ts` (commands, `globalState`, `setContext polylog.changesAllFiles`), `package.json` (two commands with `$(list-tree)` / `$(diff)`, `view/title` for `view == polylog.changes` toggled by `polylog.changesAllFiles`; `polylog.openRevision` hidden from the palette).

- [ ] **Step 4: Run, expect PASS** (unit, integration ×2). Mutation: read the whole tree recursively (`-r`) → the one-`ls-tree`-per-folder assertion fails; restore.

- [ ] **Step 5: Commit**

```bash
npm run check:denylist && git add src/allFiles.ts src/allFiles.test.ts src/changesTree.ts src/extension.ts src/logView.ts package.json src/integration/log.itest.ts && git commit -m "feat: All Files in the Changes view, read one folder at a time"
```

---

### Task 9: Polylog never reopens views; remove keepViewsExpanded

**Files:**
- Delete: `src/keepExpanded.ts`, `src/keepExpanded.test.ts`
- Modify: `src/extension.ts`, `src/logView.ts` (`expand`, `canExpand`, `onDidChangeVisibility` used only by it; `changesVisible` seam), `src/changesTree.ts` (`expand`, `canExpand`), `package.json` (setting, `test:unit` entry), `src/integration/log.itest.ts` (the keepExpanded test)

- [ ] **Step 1: Replace the keepExpanded integration test** with "Polylog never reopens a view": hide the Changes view with VS Code's per-view command `polylog.changes.removeView` (check the exact id first with `vscode.commands.getCommands(true)`, filtering for `polylog.changes`), select a commit, wait 1 s, assert `changes.visible === false` via a remaining seam (`ChangesTree.visible`); then `"polylog.changes.focus"` shows it with the selected commit's files (rule 5). Expect FAIL (the old auto-expand brings it back).

- [ ] **Step 2: Delete** the module, its test, the `UndoCollapse` wiring in `extension.ts`, the `keepViewsExpanded` setting and `test:unit` entry, `expand`/`canExpand` in both views.

- [ ] **Step 3: Run** unit + integration ×2: PASS. Commit:

```bash
npm run check:denylist && git add -A src package.json && git status --short && git commit -m "refactor: Polylog never reopens a view; remove keepViewsExpanded"
```

---

### Task 10: Docs, UI Map, perf budgets, real VS Code check

**Files:**
- Modify: `README.md`, `CLAUDE.md` (opening paragraph only), `dev/ui-map/index.html`, `src/integration/perf.itest.ts`, `docs/superpowers/specs/2026-10-01-uncommitted-view-design.md` (only if something changed during the build, as a dated note)

- [ ] **Step 1: Perf harness** — in `perf.itest.ts`: replace the toggle scenario with "badge read": time from first rows to the first `uncommitted` post with `known: true` (budget ≤ 300 ms on 68 repos), spawns by command during it (68 `status` + numstat for the 5 dirty repos); keep the save scenario (budget 2–4 spawns, `postBytes` small); add Stage of one file through `polylog.stage` (one repository read: ≤ 4 spawns); All Files on a commit: first level ≤ 100 ms. Run `xvfb-run -a npm run perf:startup`; record the numbers in the commit message.

- [ ] **Step 2: README** — Features: the Uncommitted view (stage, unstage, discard, commit), the Log's Commits | Uncommitted switch, All Files; remove the eye and Review Uncommitted wording, the `polylog.showUncommitted` and `polylog.keepViewsExpanded` rows from Extension Settings.

- [ ] **Step 3: CLAUDE.md** — replace "Merging the log is the entire product. Everything else is a non-goal." with "Merging the log is the core of the product; the panel also gives a cross-repository view of uncommitted work (and, later, of two branches). Anything else is a non-goal." Keep the five constraints untouched.

- [ ] **Step 4: UI Map** (`/ui-map` skill rules) — add: Commits | Uncommitted switch, Uncommitted list row, totals, All Files toggle, the Uncommitted view with Uncommitted repo row, Staged group, Changes group, Uncommitted file row (blue: they exist now); remove: Uncommitted row (16), the eye and checklist from the Log toolbar's description, Review Uncommitted from the Mode bar. Browser check once (boxes, click to copy, no horizontal scroll).

- [ ] **Step 5: Real VS Code check** — with `dev/demo/capture.sh`'s setup (scratchpad copy): first install shows UNCOMMITTED collapsed; open it; hover a file (Stage/Discard icons); Discard opens the modal; the switch in the Log; All Files. Dark, light, high contrast screenshots. Fix what looks wrong; no new screenshots in the repo.

- [ ] **Step 6: Final suite and commit**

```bash
npm test && npm run lint && npm run typecheck && npm run check:theme && npm run check:design && npm run check:denylist && xvfb-run -a npm run test:integration && POLYLOG_VSCODE_VERSION=1.85.0 xvfb-run -a npm run test:integration && git add README.md CLAUDE.md dev/ui-map/index.html src/integration/perf.itest.ts && git commit -m "docs: README, UI Map and CLAUDE.md for the Uncommitted view; perf budgets"
```

Then push the branch, open the PR, and run the whole-branch review (superpowers:requesting-code-review) before asking the maintainer to merge.
