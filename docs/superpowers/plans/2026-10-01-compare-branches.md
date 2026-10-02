# Compare Branches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An editor tab that compares two branches across every ticked repository: ◀ left only, ▶ right only, = on both, as file trees (default) or commits, each file opening its diff.

**Architecture:** A pure `compareModel.ts` builds every git argument and parses every output; a host `CompareStore` runs the reads per repository through the Log's counted runner and pool, with abort and generation numbers; a host `ComparePanel` owns one `WebviewPanel` and its messages; a plain-TS webview page under `src/webview/compare/` draws the toolbar, Branch picker, repo list, columns and On both strip. `LogView` only exposes its ticked repositories, a scope event, a refs event and a diff title option.

**Tech Stack:** TypeScript, esbuild, VS Code API (engines ^1.85), git CLI, plain DOM webview, `assert` unit tests, `@vscode/test-electron` integration tests.

**Spec:** `docs/superpowers/specs/2026-10-01-compare-branches-design.md` (read it first; part names follow the UI Map).

## Global Constraints

- No index, no cache, no database: every number is a git read when asked for (CLAUDE.md constraint 1).
- Only `--vscode-*` variables for color and type; light, dark and high contrast (constraint 2). `npm run check:theme` and `npm run check:design` must pass.
- Neutral names only: `acme-web`, `acme-api`, `acme-libs`, `origin/release-1.4`, authors `dana` / `rin` (constraint 3). `npm run check:denylist` must pass.
- All spawns async, through `runPool` and the Log's counted runner; a new pair, swap or tick change aborts reads in flight (constraint 4).
- Do not bump the version, edit CHANGELOG, tag or publish (constraint 5).
- No framework in the webview; strings reach the DOM only through `h()` (text nodes, never HTML).
- Every new `src/*.test.ts` is appended to `test:unit` in `package.json`.
- Branch names from the webview pass `isValidRef` (`src/filterModel.ts`) before reaching git; after `rev-parse`, git only ever sees commit ids (`isSha`).
- Commits: `git add <files>` + `git commit` on the current branch only, identity `lntvan166 <lntvan166@gmail.com>`; message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Integration tests run on stable (`xvfb-run -a npm run test:integration`) and on the floor (`POLYLOG_VSCODE_VERSION=1.85.0 xvfb-run -a npm run test:integration`).

## Review Focus

1. A branch name from the webview that is not a ref (`-x`, `a..b`, `HEAD~3`, empty) — ignored, never spawned. (Task 1 unit test, Task 4 itest.)
2. Unticking a repository while a read is in flight — the late result never shows the unticked repository. (Task 2 itest.)
3. Swap, then select a repository — the left column shows the new left branch's side (counts mirrored, detail read in the new orientation). (Task 4 itest.)
4. A file renamed on one side — Files lists it under its new path with `← old`, and **both** matches on the new path. (Task 1 unit test.)
5. Closing the tab while reads are in flight — no error, no post to a disposed webview, the next open reads again. (Task 4 itest.)

---

### Task 1: compareModel — every git argument and parser

**Files:**
- Create: `src/compareModel.ts`
- Create: `src/compareModel.test.ts`
- Modify: `package.json` (`test:unit`: append the new test)

**Interfaces:**
- Consumes: `isValidRef` (`src/filterModel.ts`), `parseShow` (`src/commitDetail.ts`), `FileChange` (`src/types.ts`).
- Produces (all exported from `src/compareModel.ts`):
  - `interface Pair { left: string; right: string }`
  - `type Side = "left" | "right"`
  - `type RepoCompare = { kind: "missing" } | { kind: "identical" } | { kind: "nobase" } | { kind: "error"; reason: string } | { kind: "differs"; leftSha: string; rightSha: string; base: string; left: number; right: number; sameLeft: number; sameRight: number }`
  - `interface SideCommit { mark: "+" | "="; sha: string; parents: string[]; time: number; author: string; subject: string }`
  - `interface Duplicate { subject: string; left?: string; right?: string }`
  - `interface PickerItem { kind: "pair"; pair: Pair } | { kind: "name"; name: string; count: number; favorite: boolean }` (as a union type `PickerItem`)
  - `interface PickerGroup { title: string; items: PickerItem[] }`
  - `validPair(p: unknown): p is Pair`
  - `revParseArgs(p: Pair): string[]`, `parseRevParse(out: string): [string, string] | null`
  - `mergeBaseArgs(l: string, r: string): string[]`
  - `sideCountArgs(side: Side, l: string, r: string): string[]`, `parseSideCount(out: string): { only: number; same: number }`
  - `filesArgs(base: string, tip: string): string[]`, `parseFiles(out: string): FileChange[]`
  - `logArgs(side: Side, l: string, r: string, max: number): string[]`, `parseSideLog(out: string): SideCommit[]`
  - `bothPaths(a: readonly FileChange[], b: readonly FileChange[]): Set<string>`
  - `pairDuplicates(left: readonly SideCommit[], right: readonly SideCommit[]): Duplicate[]`
  - `mirror(c: RepoCompare): RepoCompare`
  - `summaryLabel(results: readonly RepoCompare[], ticked: number): string`
  - `tabTitle(p: Pair | null): string`
  - `pushRecent(recent: readonly Pair[], p: Pair, cap?: number): Pair[]`
  - `pickerGroups(names: readonly { name: string; count: number }[], favorites: readonly string[], recent: readonly Pair[], query: string): PickerGroup[]`
  - `COMMIT_PAGE = 500`

- [ ] **Step 1: Write the failing test**

Create `src/compareModel.test.ts`:

```ts
import * as assert from "assert";
import {
  bothPaths, COMMIT_PAGE, filesArgs, logArgs, mergeBaseArgs, mirror, pairDuplicates, parseFiles, parseRevParse,
  parseSideCount, parseSideLog, pickerGroups, pushRecent, revParseArgs, sideCountArgs, summaryLabel, tabTitle, validPair,
  type RepoCompare,
} from "./compareModel";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

// Branch names from the webview: only refs git would accept as a branch name.
assert.ok(validPair({ left: "origin/release-1.4", right: "main" }));
for (const bad of ["-x", "a..b", "HEAD~3", "", "x y", "re^{commit}"]) assert.ok(!validPair({ left: bad, right: "main" }), bad);
assert.ok(!validPair({ left: "main" }));
assert.ok(!validPair(null));
console.log("ok - a pair is two names git accepts as branches");

assert.deepStrictEqual(revParseArgs({ left: "origin/release-1.4", right: "main" }), ["rev-parse", "origin/release-1.4^{commit}", "main^{commit}"]);
assert.deepStrictEqual(parseRevParse(`${A}\n${B}\n`), [A, B]);
assert.strictEqual(parseRevParse(`${A}\n`), null);
assert.strictEqual(parseRevParse("nope\nzz\n"), null);
console.log("ok - both branches resolve to commit ids, or the repository lacks one");

assert.deepStrictEqual(mergeBaseArgs(A, B), ["merge-base", A, B]);
assert.deepStrictEqual(sideCountArgs("left", A, B), ["rev-list", "--left-only", "--cherry-mark", "--count", `${A}...${B}`]);
assert.deepStrictEqual(sideCountArgs("right", A, B), ["rev-list", "--right-only", "--cherry-mark", "--count", `${A}...${B}`]);
assert.deepStrictEqual(parseSideCount("2\t1\n"), { only: 2, same: 1 });
assert.deepStrictEqual(parseSideCount("3\n"), { only: 3, same: 0 });
assert.deepStrictEqual(parseSideCount(""), { only: 0, same: 0 });
console.log("ok - each side counts its own commits and its duplicates");

assert.deepStrictEqual(filesArgs(C, A), ["diff", "--raw", "--numstat", "-z", "-M", C, A]);
// --raw records, then --numstat records; a rename carries both names.
const raw = [
  ":000000 100644 0000000 1111111 A", "src/limit.go",
  ":100644 100644 2222222 3333333 R090", "src/old.go", "src/new.go",
  ":100644 100644 4444444 5555555 M", "bin.png",
  "40\t0\tsrc/limit.go", "1\t1\t", "src/old.go", "src/new.go", "-\t-\tbin.png", "",
].join("\0");
const files = parseFiles(raw);
assert.deepStrictEqual(files.map((f) => [f.path, f.oldPath, f.status, f.added, f.deleted]), [
  ["src/limit.go", undefined, "A", 40, 0],
  ["src/new.go", "src/old.go", "R", 1, 1],
  ["bin.png", undefined, "M", null, null],
]);
console.log("ok - Files reads each changed file with its status, rename and counts");

const other = parseFiles(["1\t1\tsrc/new.go", "2\t0\tREADME.md", ""].join("\0"));
assert.deepStrictEqual([...bothPaths(files, other)], ["src/new.go"]);
console.log("ok - a file changed on both sides is matched on its new path");

assert.deepStrictEqual(logArgs("left", A, B, COMMIT_PAGE), [
  "log", "--left-only", "--cherry-mark", "--max-count=500", "--format=%m%x1f%H%x1f%P%x1f%ct%x1f%aN%x1f%s%x1e", `${A}...${B}`,
]);
const log = parseSideLog(`<\x1f${A}\x1f${C}\x1f1758000300\x1fdana\x1ffeat: rate limit\x1e\n=\x1f${B}\x1f${C} ${A}\x1f1758000200\x1frin\x1ffix: retry on 503\x1e\n`);
assert.deepStrictEqual(log, [
  { mark: "+", sha: A, parents: [C], time: 1758000300, author: "dana", subject: "feat: rate limit" },
  { mark: "=", sha: B, parents: [C, A], time: 1758000200, author: "rin", subject: "fix: retry on 503" },
]);
console.log("ok - a side's log marks its duplicates");

const dl = [{ mark: "=" as const, sha: A, parents: [], time: 2, author: "dana", subject: "fix: retry on 503" }, { mark: "=" as const, sha: C, parents: [], time: 1, author: "dana", subject: "fix: squash" }];
const dr = [{ mark: "=" as const, sha: B, parents: [], time: 3, author: "rin", subject: "fix: retry on 503" }];
assert.deepStrictEqual(pairDuplicates(dl, dr), [
  { subject: "fix: retry on 503", left: A, right: B },
  { subject: "fix: squash", left: C },
]);
console.log("ok - duplicates pair up by subject, the rest stay on their side");

const differs: RepoCompare = { kind: "differs", leftSha: A, rightSha: B, base: C, left: 2, right: 1, sameLeft: 1, sameRight: 1 };
assert.deepStrictEqual(mirror(differs), { kind: "differs", leftSha: B, rightSha: A, base: C, left: 1, right: 2, sameLeft: 1, sameRight: 1 });
assert.deepStrictEqual(mirror({ kind: "missing" }), { kind: "missing" });
console.log("ok - swap mirrors a result without reading git");

const results: RepoCompare[] = [differs, { ...differs, left: 5, right: 0, sameLeft: 0, sameRight: 0 }, { kind: "identical" }, { kind: "missing" }, { kind: "missing" }, { kind: "nobase" }];
assert.strictEqual(summaryLabel(results, 6), "3 repositories differ · ◀7 ▶1 =1 · 1 identical · 2 missing a branch · in 6 repositories");
assert.strictEqual(summaryLabel([{ kind: "identical" }], 1), "0 repositories differ · ◀0 ▶0 =0 · 1 identical · in 1 repository");
console.log("ok - the summary counts what differs, what is identical and what is missing");

assert.strictEqual(tabTitle({ left: "origin/release-1.4", right: "origin/main" }), "⇄ release-1.4 ↔ main");
assert.strictEqual(tabTitle(null), "⇄ Compare Branches");
console.log("ok - the tab is named after the pair");

const p1 = { left: "origin/release-1.4", right: "origin/main" };
const p2 = { left: "origin/release-1.3", right: "origin/prod" };
let recent = pushRecent([], p1);
recent = pushRecent(recent, p2);
recent = pushRecent(recent, p1);
assert.deepStrictEqual(recent, [p1, p2]);
for (let i = 0; i < 9; i++) recent = pushRecent(recent, { left: `rel-${i}`, right: "main" });
assert.strictEqual(recent.length, 5);
console.log("ok - recent pairs: newest first, once each, at most five");

const names = [{ name: "origin/main", count: 68 }, { name: "main", count: 68 }, { name: "origin/release-1.4", count: 56 }, { name: "feat/billing", count: 3 }];
const groups = pickerGroups(names, ["origin/main"], [p1], "");
assert.deepStrictEqual(groups.map((g) => [g.title, g.items.length]), [["Recent pairs", 1], ["Favorites", 1], ["Local", 2], ["Remote", 2]]);
const searched = pickerGroups(names, ["origin/main"], [p1], "REL");
assert.deepStrictEqual(searched.map((g) => g.title), ["Remote"]);
assert.deepStrictEqual(pickerGroups(names, [], [], "zzz"), []);
console.log("ok - the Branch picker groups names and filters them as you type");
```

- [ ] **Step 2: Append the test to `test:unit` and run it to verify it fails**

In `package.json`, append to the end of the `test:unit` string:

```
 && esbuild src/compareModel.test.ts --bundle --platform=node --format=cjs --outfile=out/compareModel.test.cjs && node out/compareModel.test.cjs
```

Run: `npm test 2>&1 | tail -5`
Expected: FAIL — esbuild: `Could not resolve "./compareModel"`.

- [ ] **Step 3: Write the implementation**

Create `src/compareModel.ts`:

```ts
// Compare Branches: every git argument and parser. Pure: no vscode import.
import { parseShow } from "./commitDetail";
import { isValidRef } from "./filterModel";
import type { FileChange } from "./types";

export interface Pair {
  left: string;
  right: string;
}
export type Side = "left" | "right";

/** One repository's comparison of the pair. */
export type RepoCompare =
  | { kind: "missing" }
  | { kind: "identical" }
  | { kind: "nobase" }
  | { kind: "error"; reason: string }
  | { kind: "differs"; leftSha: string; rightSha: string; base: string; left: number; right: number; sameLeft: number; sameRight: number };

export interface SideCommit {
  /** "+": only on this side; "=": the same change is on the other side too. */
  mark: "+" | "=";
  sha: string;
  parents: string[];
  time: number;
  author: string;
  subject: string;
}
export interface Duplicate {
  subject: string;
  left?: string;
  right?: string;
}
export type PickerItem = { kind: "pair"; pair: Pair } | { kind: "name"; name: string; count: number; favorite: boolean };
export interface PickerGroup {
  title: string;
  items: PickerItem[];
}

/** Commits shown per side before "Show 500 more". */
export const COMMIT_PAGE = 500;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Names cross the webview boundary: only what git accepts as a branch name reaches git. */
export function validPair(p: unknown): p is Pair {
  const o = p as Partial<Pair> | null;
  return typeof o?.left === "string" && typeof o.right === "string" && isValidRef(o.left) && isValidRef(o.right);
}

export function revParseArgs(p: Pair): string[] {
  return ["rev-parse", `${p.left}^{commit}`, `${p.right}^{commit}`];
}

export function parseRevParse(out: string): [string, string] | null {
  const ids = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return ids.length === 2 && ids.every((id) => /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(id)) ? [ids[0], ids[1]] : null;
}

export function mergeBaseArgs(l: string, r: string): string[] {
  return ["merge-base", l, r];
}

/** A side's commits the other lacks, and (counted apart) its commits whose change the other has too. */
export function sideCountArgs(side: Side, l: string, r: string): string[] {
  return ["rev-list", side === "left" ? "--left-only" : "--right-only", "--cherry-mark", "--count", `${l}...${r}`];
}

export function parseSideCount(out: string): { only: number; same: number } {
  const [only, same] = out.trim().split(/\s+/).map(Number);
  return { only: Number.isFinite(only) ? only : 0, same: Number.isFinite(same) ? same : 0 };
}

/** What a side changed since the branches split: merge base → its tip, statuses and counts in one spawn. */
export function filesArgs(base: string, tip: string): string[] {
  return ["diff", "--raw", "--numstat", "-z", "-M", base, tip];
}

export function parseFiles(out: string): FileChange[] {
  return parseShow(out).files;
}

export function logArgs(side: Side, l: string, r: string, max: number): string[] {
  return ["log", side === "left" ? "--left-only" : "--right-only", "--cherry-mark", `--max-count=${max}`, "--format=%m%x1f%H%x1f%P%x1f%ct%x1f%aN%x1f%s%x1e", `${l}...${r}`];
}

export function parseSideLog(out: string): SideCommit[] {
  return out.split("\x1e").map((rec) => rec.replace(/^\n+/, "")).filter(Boolean).map((rec) => {
    const [m, sha, parents, time, author, subject] = rec.split("\x1f");
    return { mark: m === "=" ? "=" : "+", sha, parents: parents ? parents.split(" ") : [], time: Number(time), author, subject: subject ?? "" };
  });
}

export function bothPaths(a: readonly FileChange[], b: readonly FileChange[]): Set<string> {
  const other = new Set(b.map((f) => f.path));
  return new Set(a.map((f) => f.path).filter((p) => other.has(p)));
}

/** Duplicates for display: a left and a right one with the same subject share a row. Counts come from git. */
export function pairDuplicates(left: readonly SideCommit[], right: readonly SideCommit[]): Duplicate[] {
  const rights = [...right];
  const out: Duplicate[] = [];
  for (const l of left) {
    const i = rights.findIndex((r) => r.subject === l.subject);
    if (i >= 0) {
      out.push({ subject: l.subject, left: l.sha, right: rights[i].sha });
      rights.splice(i, 1);
    } else out.push({ subject: l.subject, left: l.sha });
  }
  for (const r of rights) out.push({ subject: r.subject, right: r.sha });
  return out;
}

export function mirror(c: RepoCompare): RepoCompare {
  if (c.kind !== "differs") return c;
  return { kind: "differs", leftSha: c.rightSha, rightSha: c.leftSha, base: c.base, left: c.right, right: c.left, sameLeft: c.sameRight, sameRight: c.sameLeft };
}

export function summaryLabel(results: readonly RepoCompare[], ticked: number): string {
  let differ = 0, l = 0, r = 0, same = 0, identical = 0, missing = 0;
  for (const c of results) {
    if (c.kind === "identical") identical++;
    else if (c.kind === "missing") missing++;
    else {
      differ++;
      if (c.kind === "differs") {
        l += c.left;
        r += c.right;
        same += c.sameLeft;
      }
    }
  }
  const parts = [`${differ} ${differ === 1 ? "repository differs" : "repositories differ"}`, `◀${l} ▶${r} =${same}`, `${identical} identical`];
  if (missing > 0) parts.push(`${missing} missing a branch`);
  parts.push(`in ${plural(ticked, "repository", "repositories")}`);
  return parts.join(" · ");
}

export function tabTitle(p: Pair | null): string {
  if (!p) return "⇄ Compare Branches";
  const short = (n: string) => n.replace(/^origin\//, "");
  return `⇄ ${short(p.left)} ↔ ${short(p.right)}`;
}

export function pushRecent(recent: readonly Pair[], p: Pair, cap = 5): Pair[] {
  return [p, ...recent.filter((x) => x.left !== p.left || x.right !== p.right)].slice(0, cap);
}

/** Recent pairs (not while searching), Favorites, Local, Remote; a name may be in Favorites and its own group. */
export function pickerGroups(names: readonly { name: string; count: number }[], favorites: readonly string[], recent: readonly Pair[], query: string): PickerGroup[] {
  const q = query.trim().toLowerCase();
  const match = (n: string) => q === "" || n.toLowerCase().includes(q);
  const fav = new Set(favorites);
  const item = (n: { name: string; count: number }): PickerItem => ({ kind: "name", name: n.name, count: n.count, favorite: fav.has(n.name) });
  const sorted = [...names].filter((n) => match(n.name)).sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const remote = (n: string) => isRemoteName(n);
  const groups: PickerGroup[] = [];
  if (q === "" && recent.length > 0) groups.push({ title: "Recent pairs", items: recent.map((pair) => ({ kind: "pair", pair })) });
  const favs = sorted.filter((n) => fav.has(n.name));
  if (favs.length > 0) groups.push({ title: "Favorites", items: favs.map(item) });
  const local = sorted.filter((n) => !remote(n.name));
  if (local.length > 0) groups.push({ title: "Local", items: local.map(item) });
  const rem = sorted.filter((n) => remote(n.name));
  if (rem.length > 0) groups.push({ title: "Remote", items: rem.map(item) });
  return groups;
}

/** Remote-tracking names come from refs/remotes: "<remote>/<branch>". The store marks them with this prefix list. */
let remotes: ReadonlySet<string> = new Set(["origin", "upstream"]);
function isRemoteName(n: string): boolean {
  return remotes.has(n.split("/")[0]);
}
/** The remotes the store found (`git for-each-ref refs/remotes`), so "feat/billing" stays Local. */
export function setRemoteNames(names: Iterable<string>): void {
  remotes = new Set(names);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test 2>&1 | grep -E "compare|Error|AssertionError" ; npm test >/dev/null 2>&1; echo exit=$?`
Expected: the 12 `ok - …` lines of this file, `exit=0`.

If the "Local" count is wrong it is because `feat/billing` was classed Remote: the default remote set is `origin` and `upstream`, and `feat` is not one.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `npm run lint 2>&1 | grep -E " error " ; npm run typecheck`
Expected: no errors.

```bash
git add src/compareModel.ts src/compareModel.test.ts package.json
git commit -m "feat: compareModel — the git reads and parsers of Compare Branches

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: CompareStore and the LogView hooks — counts for every ticked repository

**Files:**
- Create: `src/compareStore.ts`
- Modify: `src/logView.ts` (ticked repositories, scope and refs events, diff title)
- Modify: `src/extension.ts` (create the store; test seams)
- Test: `src/integration/log.itest.ts` (new `describe` block at the end of the file's top-level `describe`)

**Interfaces:**
- Consumes: everything from Task 1; `RunGit` (`src/logQuery.ts`); `runPool`, `isAbortError` (`src/pool.ts`); `GitError` (`src/git.ts`); `branchSuggestions` (`src/repos.ts`); `selectRepos` (`src/filterModel.ts`); `debounce` (`src/debounce.ts`).
- Produces:
  - `LogView.tickedRepos(): Repo[]`
  - `LogView.onDidChangeScope: vscode.Event<void>` (fires from `syncScope()`)
  - `LogView.onDidChangeRefs: vscode.Event<string | undefined>` (repo id, or undefined for every repository)
  - `LogView.branchBox: string` (the Branch box name, "" when empty)
  - `LogView.openDiff(a: OpenDiffArgs, preserveFocus?: boolean, title?: string)`
  - `class CompareStore implements vscode.Disposable`:
    - `constructor(deps: { run: RunGit; concurrency(): number; repos(): readonly Repo[] })`
    - `readonly onDidChange: vscode.Event<void>` (coalesced 80 ms)
    - `pair: Pair | null` (read-only getter), `reading: boolean`
    - `setPair(p: Pair | null): Promise<void>`
    - `swap(): void`
    - `scopeChanged(): Promise<void>`
    - `refresh(repoId?: string): Promise<void>`
    - `results(): { repo: Repo; result: RepoCompare }[]` (ticked repositories with a result, Repo List order)
    - `readFiles(repoId: string): Promise<{ left: FileChange[]; right: FileChange[]; both: string[] }>`
    - `readCommits(repoId: string, side: Side, max: number): Promise<SideCommit[]>`
    - `readCommitFiles(repoId: string, sha: string): Promise<FileChange[]>`
    - `readBranches(): Promise<{ name: string; count: number }[]>`
  - Test seam commands: `polylog._itest.compareStore` → `{ pair, reading, rows: string[] }`, `polylog._itest.comparePick` (arg `Pair | null`) → awaits `setPair`.
  - Row string format (`rowLabel(name, result)`, exported from `compareStore.ts`): `"acme-api ◀2 ▶2 =1"`, `"acme-web no common history"`, `"acme-x git error: <reason>"`, `"acme-libs identical"`, `"acme-libs missing"`.

- [ ] **Step 1: Write the failing integration test**

At the top of `src/integration/log.itest.ts` add imports next to the existing ones:

```ts
import type { Pair } from "../compareModel";
```

Then, inside the top-level `describe`, after the last existing `it(...)`, add:

```ts
  describe("Compare Branches", () => {
    const os = require("os") as typeof import("os");
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    const store = () => vscode.commands.executeCommand<{ pair: Pair | null; reading: boolean; rows: string[] }>("polylog._itest.compareStore");
    const pick = (p: Pair | null) => vscode.commands.executeCommand("polylog._itest.comparePick", p);
    const git = (root: string, args: string[], input?: string) => cp.execFileSync("git", args, { cwd: root, input, env: { ...process.env, ...ID } }).toString().trim();
    const ID = { GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com" };
    let n = 0;
    /** A commit on top of `parent` with these files, made without touching the working tree or the checked-out branch. */
    function commitOn(root: string, parent: string | null, files: Record<string, string>, message: string, time: number): string {
      const idx = path.join(os.tmpdir(), `polylog-itest-index-${process.pid}-${n++}`);
      const env = { ...process.env, ...ID, GIT_INDEX_FILE: idx, GIT_AUTHOR_DATE: `${time} +0000`, GIT_COMMITTER_DATE: `${time} +0000` };
      const run = (args: string[], input?: string) => cp.execFileSync("git", args, { cwd: root, input, env }).toString().trim();
      try {
        run(parent ? ["read-tree", parent] : ["read-tree", "--empty"]);
        for (const [name, content] of Object.entries(files)) run(["update-index", "--add", "--cacheinfo", `100644,${run(["hash-object", "-w", "--stdin"], content)},${name}`]);
        return run(["commit-tree", run(["write-tree"]), ...(parent ? ["-p", parent] : []), "-m", message]);
      } finally {
        fs.rmSync(idx, { force: true });
      }
    }
    const T = 1758001000;
    let roots: Record<string, string>;

    before(async () => {
      const s = await until("six rows", (x) => x.rows.length === 6);
      roots = Object.fromEntries(s.repos.map((r) => [r.name, r.root]));
      // acme-api: ◀ two (one a cherry-pick), ▶ two (its twin and a hotfix). acme-web: ◀ one. acme-libs: the same commit on both.
      const api = roots["acme-api"];
      const apiBase = git(api, ["rev-parse", "HEAD"]);
      const rel1 = commitOn(api, apiBase, { "limit.go": "package limit\n" }, "feat: rate limit per client", T);
      const rel2 = commitOn(api, rel1, { "retry.go": "package retry\n" }, "fix: retry on 503", T + 10);
      const prod1 = commitOn(api, apiBase, { "retry.go": "package retry\n" }, "fix: retry on 503", T + 20);
      const prod2 = commitOn(api, prod1, { "timeout.go": "package timeout\n", "limit.go": "package limit // prod\n" }, "hotfix: raise upstream timeout", T + 30);
      git(api, ["update-ref", "refs/heads/release-1.4", rel2]);
      git(api, ["update-ref", "refs/heads/prod", prod2]);
      const web = roots["acme-web"];
      const webBase = git(web, ["rev-parse", "HEAD"]);
      git(web, ["update-ref", "refs/heads/release-1.4", commitOn(web, webBase, { "billing.ts": "export {};\n" }, "feat: billing page", T + 40)]);
      git(web, ["update-ref", "refs/heads/prod", webBase]);
      git(web, ["update-ref", "refs/heads/lone", commitOn(web, null, { "README.md": "lone\n" }, "chore: unrelated history", T + 50)]);
      const libs = roots["acme-libs"];
      git(libs, ["update-ref", "refs/heads/release-1.4", "HEAD"]);
      git(libs, ["update-ref", "refs/heads/prod", "HEAD"]);
    });

    after(async () => {
      await pick(null);
      for (const root of Object.values(roots)) for (const b of ["release-1.4", "prod", "lone"]) cp.spawnSync("git", ["update-ref", "-d", `refs/heads/${b}`], { cwd: root });
      await send({ type: "filter", filter: ALL });
    });

    it("counts each side in every ticked repository; identical and missing ones are not listed", async () => {
      await pick({ left: "release-1.4", right: "prod" });
      const s = await waitFor("all read", async () => {
        const x = await store();
        return !x.reading && x.rows.length === 3 ? x : undefined;
      });
      assert.ok(s.rows.includes("acme-api ◀1 ▶1 =1"), s.rows.join(" | "));
      assert.ok(s.rows.includes("acme-web ◀1 ▶0 =0"));
      assert.ok(s.rows.includes("acme-libs identical"));
      // A branch one repository lacks.
      cp.spawnSync("git", ["update-ref", "-d", "refs/heads/prod"], { cwd: roots["acme-libs"] });
      await vscode.commands.executeCommand("polylog._itest.compareRefresh");
      await waitFor("acme-libs missing", async () => ((await store()).rows.includes("acme-libs missing") ? true : undefined));
      git(roots["acme-libs"], ["update-ref", "refs/heads/prod", "HEAD"]);
    });

    it("two branches with no shared history say so", async () => {
      await pick({ left: "lone", right: "prod" });
      const s = await waitFor("read", async () => {
        const x = await store();
        return !x.reading && x.rows.some((r) => r.startsWith("acme-web")) ? x : undefined;
      });
      assert.ok(s.rows.includes("acme-web no common history"), s.rows.join(" | "));
      assert.ok(s.rows.includes("acme-api missing"));
    });

    it("unticking a repository drops it at once, even while its read is in flight", async () => {
      const s0 = await snapshot();
      const api = s0.repos.find((r) => r.name === "acme-api")!;
      const others = s0.repos.filter((r) => r.id !== api.id).map((r) => r.id);
      const pending = pick({ left: "release-1.4", right: "prod" });
      await send({ type: "filter", filter: { ...ALL, repoIds: others } });
      await pending;
      const s = await waitFor("read", async () => {
        const x = await store();
        return !x.reading ? x : undefined;
      });
      assert.ok(!s.rows.some((r) => r.startsWith("acme-api")), s.rows.join(" | "));
      await send({ type: "filter", filter: ALL });
      await waitFor("acme-api back", async () => ((await store()).rows.includes("acme-api ◀1 ▶1 =1") ? true : undefined));
    });

    it("a name that is not a branch never reaches git", async () => {
      const before = (await snapshot()).spawnLog.length;
      await pick({ left: "-x", right: "prod" });
      await pick({ left: "a..b", right: "prod" });
      const after = await snapshot();
      assert.ok(!after.spawnLog.slice(before).some((x) => x.cmd === "rev-parse"), "no rev-parse for a bad name");
    });
  });
```

The `rows` counts: `acme-api` has `◀1 ▶1 =1` because the cherry-pick is counted on each side as a duplicate (`sameLeft = 1`), leaving one unique commit per side (`rate limit` ◀, `hotfix` ▶).

- [ ] **Step 2: Run it to verify it fails**

Run: `xvfb-run -a npm run test:integration > /tmp/itest.log 2>&1; grep -E "passing|failing|Compare" /tmp/itest.log | sed 's/\x1b\[[0-9;]*m//g'`
Expected: FAIL — `command 'polylog._itest.comparePick' not found` (4 failing in "Compare Branches").

- [ ] **Step 3: Add the LogView hooks**

In `src/logView.ts`:

1. Next to `private sync = new Map<string, AheadBehind>();` add:

```ts
  private readonly scopeChanged = new vscode.EventEmitter<void>();
  /** The ticked repositories changed (the Compare tab reads what it lacks). */
  readonly onDidChangeScope = this.scopeChanged.event;
  private readonly refsChanged = new vscode.EventEmitter<string | undefined>();
  /** Branches moved: in one repository (its id), or in every one (undefined, after Fetch All). */
  readonly onDidChangeRefs = this.refsChanged.event;

  /** The repositories ticked in the Repo List, in its order. */
  tickedRepos(): Repo[] {
    return selectRepos(this.filter, this.repos);
  }

  /** The Branch box's name ("" when empty): Compare with… starts from it. */
  get branchBox(): string {
    return this.filter.branch;
  }
```

2. In `syncScope()`, after the `this.deps.uncommitted.setScope(...)` line, add `this.scopeChanged.fire();`.

3. In `fetchAll()`, replace the body with:

```ts
    this.fetching ??= this.runFetchAll().finally(() => {
      this.fetching = undefined;
      this.refsChanged.fire(undefined);
    });
    return this.fetching;
```

4. At the end of `repoPull` (after `await this.readSync(new Set([repo.id]));`) add `this.refsChanged.fire(repo.id);`.

5. In `repoStateChanged`, after `if (!repo) return;` add `this.refsChanged.fire(repo.id);` (it runs only when `headMoved`).

6. Change the `openDiff` signature and title line:

```ts
  async openDiff(a: OpenDiffArgs, preserveFocus = false, title?: string): Promise<string | undefined> {
```

and

```ts
    const label = title ?? `${path.posix.basename(a.path)} (${a.sha.slice(0, 7)}) — ${repo.name}`;
```

using `label` in the `vscode.diff` call instead of `title`.

7. In the class's dispose (where other emitters are disposed; search `dispose()` in `LogView`), add `this.scopeChanged.dispose(); this.refsChanged.dispose();`.

- [ ] **Step 4: Write the store**

Create `src/compareStore.ts`:

```ts
import * as vscode from "vscode";
import { showArgs } from "./commitDetail";
import {
  bothPaths, filesArgs, logArgs, mergeBaseArgs, mirror, parseFiles, parseRevParse, parseSideCount, parseSideLog,
  revParseArgs, setRemoteNames, sideCountArgs, type Pair, type RepoCompare, type Side, type SideCommit,
} from "./compareModel";
import { parseShow } from "./commitDetail";
import { GitError } from "./git";
import type { RunGit } from "./logQuery";
import { isAbortError, runPool } from "./pool";
import { branchSuggestions } from "./repos";
import type { FileChange, Repo } from "./types";

export interface CompareDeps {
  run: RunGit;
  concurrency(): number;
  /** The ticked repositories, in Repo List order. */
  repos(): readonly Repo[];
}

/** A result as the tests and the list name it. */
export function rowLabel(name: string, c: RepoCompare): string {
  switch (c.kind) {
    case "differs": return `${name} ◀${c.left} ▶${c.right} =${c.sameLeft}`;
    case "nobase": return `${name} no common history`;
    case "error": return `${name} git error: ${c.reason}`;
    default: return `${name} ${c.kind}`;
  }
}

/**
 * Two branches compared in each ticked repository: one read per repository when the pair is
 * picked, kept until the pair, the ticks or a branch changes. Nothing here is a cache: every
 * number is the answer of the last git read, and each change of what was asked reads again.
 */
export class CompareStore implements vscode.Disposable {
  private current: Pair | null = null;
  private readonly map = new Map<string, RepoCompare>();
  /** Bumped by every new pair and swap: a read of an older one is dropped when it lands. */
  private gen = 0;
  private ctl = new AbortController();
  private inFlight = 0;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: CompareDeps) {}

  get pair(): Pair | null {
    return this.current;
  }

  get reading(): boolean {
    return this.inFlight > 0;
  }

  /** A new pair: everything in flight stops, every ticked repository is read. null forgets it. */
  async setPair(p: Pair | null): Promise<void> {
    this.ctl.abort();
    this.ctl = new AbortController();
    this.gen++;
    this.current = p;
    this.map.clear();
    this.changed();
    if (p && p.left !== p.right) await this.read(this.deps.repos());
  }

  /** Left and right trade places: the results are mirrored, nothing is read. */
  swap(): void {
    if (!this.current) return;
    this.ctl.abort();
    this.ctl = new AbortController();
    this.gen++;
    this.current = { left: this.current.right, right: this.current.left };
    for (const [id, c] of this.map) this.map.set(id, mirror(c));
    this.changed();
  }

  /** The ticks changed: unticked repositories leave at once, newly ticked ones are read. */
  async scopeChanged(): Promise<void> {
    const ids = new Set(this.deps.repos().map((r) => r.id));
    for (const id of [...this.map.keys()]) if (!ids.has(id)) this.map.delete(id);
    this.changed();
    if (!this.current || this.current.left === this.current.right) return;
    await this.read(this.deps.repos().filter((r) => !this.map.has(r.id)));
  }

  /** Reads again: one repository (its branches moved) or all (Refresh, Fetch All). */
  async refresh(repoId?: string): Promise<void> {
    if (!this.current || this.current.left === this.current.right) return;
    const repos = this.deps.repos().filter((r) => repoId === undefined || r.id === repoId);
    await this.read(repos);
  }

  results(): { repo: Repo; result: RepoCompare }[] {
    return this.deps.repos().flatMap((repo) => {
      const result = this.map.get(repo.id);
      return result ? [{ repo, result }] : [];
    });
  }

  private async read(repos: readonly Repo[]): Promise<void> {
    const p = this.current;
    if (!p || repos.length === 0) return;
    const gen = this.gen;
    const signal = this.ctl.signal;
    this.inFlight++;
    this.changed();
    try {
      await runPool(repos, this.deps.concurrency(), async (r, s) => {
        const result = await this.readOne(r, p, s);
        // A newer pair or swap, or the repository was unticked meanwhile: drop it.
        if (gen !== this.gen || signal.aborted || !this.deps.repos().some((x) => x.id === r.id)) return;
        this.map.set(r.id, result);
        this.changed();
      }, signal);
    } finally {
      this.inFlight--;
      this.changed();
    }
  }

  private async readOne(r: Repo, p: Pair, signal: AbortSignal): Promise<RepoCompare> {
    let ids: [string, string] | null;
    try {
      ids = parseRevParse(await this.deps.run(r.root, revParseArgs(p), signal));
    } catch (e) {
      if (isAbortError(e)) throw e;
      return { kind: "missing" };
    }
    if (!ids) return { kind: "missing" };
    const [l, rt] = ids;
    if (l === rt) return { kind: "identical" };
    try {
      let base: string;
      try {
        base = (await this.deps.run(r.root, mergeBaseArgs(l, rt), signal)).trim();
      } catch (e) {
        if (e instanceof GitError && e.exitCode === 1) return { kind: "nobase" };
        throw e;
      }
      const [left, right] = await Promise.all([
        this.deps.run(r.root, sideCountArgs("left", l, rt), signal).then(parseSideCount),
        this.deps.run(r.root, sideCountArgs("right", l, rt), signal).then(parseSideCount),
      ]);
      return { kind: "differs", leftSha: l, rightSha: rt, base, left: left.only, right: right.only, sameLeft: left.same, sameRight: right.same };
    } catch (e) {
      if (isAbortError(e)) throw e;
      return { kind: "error", reason: e instanceof Error ? e.message : String(e) };
    }
  }

  private differs(repoId: string): { repo: Repo; c: Extract<RepoCompare, { kind: "differs" }> } | undefined {
    const repo = this.deps.repos().find((r) => r.id === repoId);
    const c = this.map.get(repoId);
    return repo && c?.kind === "differs" ? { repo, c } : undefined;
  }

  /** Files mode for one repository: each side's changes since the split, and the paths both changed. */
  async readFiles(repoId: string): Promise<{ left: FileChange[]; right: FileChange[]; both: string[] }> {
    const d = this.differs(repoId);
    if (!d) return { left: [], right: [], both: [] };
    const signal = this.ctl.signal;
    const [left, right] = await Promise.all([
      this.deps.run(d.repo.root, filesArgs(d.c.base, d.c.leftSha), signal).then(parseFiles),
      this.deps.run(d.repo.root, filesArgs(d.c.base, d.c.rightSha), signal).then(parseFiles),
    ]);
    return { left, right, both: [...bothPaths(left, right)] };
  }

  /** Commits mode for one side of one repository, newest first. */
  async readCommits(repoId: string, side: Side, max: number): Promise<SideCommit[]> {
    const d = this.differs(repoId);
    if (!d) return [];
    return parseSideLog(await this.deps.run(d.repo.root, logArgs(side, d.c.leftSha, d.c.rightSha, max), this.ctl.signal));
  }

  async readCommitFiles(repoId: string, sha: string): Promise<FileChange[]> {
    const repo = this.deps.repos().find((r) => r.id === repoId);
    if (!repo) return [];
    return parseShow(await this.deps.run(repo.root, showArgs(sha), this.ctl.signal)).files;
  }

  /** Branch names across the ticked repositories, with how many have each (the Branch picker). */
  async readBranches(): Promise<{ name: string; count: number }[]> {
    const repos = [...this.deps.repos()];
    const settled = await runPool(repos, this.deps.concurrency(),
      (r, signal) => this.deps.run(r.root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], signal), new AbortController().signal);
    const remotes = new Set<string>();
    const lists = settled.map((s) => (s.status === "fulfilled" ? s.value.split("\n").map((l) => l.trim()).filter(Boolean) : []).map((ref) => {
      const m = /^refs\/remotes\/([^/]+)\//.exec(ref);
      if (m) remotes.add(m[1]);
      return ref.replace(/^refs\/(heads|remotes)\//, "");
    }));
    setRemoteNames(remotes);
    return branchSuggestions(lists);
  }

  private changed(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.emitter.fire();
    }, 80);
  }

  dispose(): void {
    this.ctl.abort();
    clearTimeout(this.timer);
    this.emitter.dispose();
  }
}
```

Merge the two `./commitDetail` imports into one (`import { parseShow, showArgs } from "./commitDetail";`).

- [ ] **Step 5: Wire it in `extension.ts`**

After `const uncommittedView = new UncommittedView(...)` add:

```ts
  const compare = new CompareStore({
    run: (root, args, signal) => log.countedRun(root, args, signal),
    concurrency: () => vscode.workspace.getConfiguration("polylog").get<number>("maxConcurrency", 16),
    repos: () => log.tickedRepos(),
  });
```

Add `compare` to `context.subscriptions`, and in the subscriptions list:

```ts
    log.onDidChangeScope(() => void compare.scopeChanged()),
```

In the `_itest` block, next to the other seams:

```ts
      vscode.commands.registerCommand("polylog._itest.compareStore", () => ({
        pair: compare.pair, reading: compare.reading, rows: compare.results().map((x) => rowLabel(x.repo.name, x.result)),
      })),
      vscode.commands.registerCommand("polylog._itest.comparePick", (p: unknown) => compare.setPair(p === null ? null : validPair(p) ? p : null).then(() => undefined)),
      vscode.commands.registerCommand("polylog._itest.compareRefresh", () => compare.refresh()),
```

The seam maps an invalid pair to `null`, so a bad name is never spawned (Review Focus 1); the panel (Task 3) ignores invalid picks instead. Import `CompareStore`, `rowLabel` from `./compareStore` and `validPair` from `./compareModel`.

- [ ] **Step 6: Run the integration tests to verify they pass**

Run: `npm run typecheck && xvfb-run -a npm run test:integration > /tmp/itest.log 2>&1; grep -E "passing|failing" /tmp/itest.log | sed 's/\x1b\[[0-9;]*m//g'`
Expected: `47 passing` (43 + 4), 0 failing.

Mutation check: in `CompareStore.read`, delete `|| !this.deps.repos().some((x) => x.id === r.id)`; re-run; expected: "unticking a repository drops it at once…" fails (if it passes because the read finished before the untick, note it in the ledger as a ruling and keep the guard). Restore.

- [ ] **Step 7: Commit**

```bash
git add src/compareStore.ts src/logView.ts src/extension.ts src/integration/log.itest.ts
git commit -m "feat: CompareStore — each ticked repository's two branches, counted

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The Compare tab — host panel, protocol and command

**Files:**
- Create: `src/comparePanel.ts`
- Create: `src/compareProtocol.ts`
- Create: `src/webview/compare/html.ts`
- Create: `src/webview/compare/main.ts` (minimal: posts `ready`; Task 4 fills it)
- Create: `src/webview/compare/compare.css` (one rule until Task 4: `:root { color-scheme: normal; }`)
- Modify: `src/extension.ts`, `package.json`, `.vscodeignore`
- Test: `src/integration/log.itest.ts` (inside `describe("Compare Branches")`)

**Interfaces:**
- Consumes: `CompareStore` (Task 2), `LogView.openDiff/branchBox/onDidChangeRefs` (Task 2), compareModel (Task 1), `HtmlOptions` (`src/webview/html.ts`), `assignAccents`/`accentOf` (`src/webview/view.ts`), `isSha`.
- Produces:
  - `src/compareProtocol.ts`:

```ts
import type { Duplicate, Pair, Side } from "./compareModel";
import type { ChangeStatus } from "./types";

export type CompareMode = "files" | "commits";
export interface CRepoRow { repoId: string; name: string; accent: number; status: "differs" | "nobase" | "error"; left: number; right: number; same: number; reason?: string; behind: boolean }
export interface CFile { path: string; oldPath?: string; status?: ChangeStatus; added: number | null; deleted: number | null; both: boolean }
export interface CCommit { sha: string; parent: string | null; subject: string; author: string; time: number; files: number | null }
export type CompareHost =
  | { type: "state"; pair: Pair | null; mode: CompareMode; recent: Pair[]; favorites: string[]; message?: string }
  | { type: "repos"; reading: boolean; summary: string; rows: CRepoRow[]; identical: number; missing: string[] }
  | { type: "detail"; repoId: string; mode: CompareMode; left: CFile[] | CCommit[]; right: CFile[] | CCommit[]; more: { left: boolean; right: boolean }; duplicates: Duplicate[]; error?: string }
  | { type: "commitFiles"; repoId: string; sha: string; files: CFile[] }
  | { type: "branches"; names: { name: string; count: number }[] };
export type CompareWebview =
  | { type: "ready" }
  | { type: "pick"; pair: Pair }
  | { type: "swap" }
  | { type: "mode"; mode: CompareMode }
  | { type: "refresh" }
  | { type: "select"; repoId: string }
  | { type: "favorite"; name: string }
  | { type: "wantBranches" }
  | { type: "openFile"; repoId: string; side: Side; path: string }
  | { type: "expand"; repoId: string; sha: string }
  | { type: "openCommitFile"; repoId: string; sha: string; path: string }
  | { type: "more"; repoId: string; side: Side };
```

  - `class ComparePanel implements vscode.Disposable`:
    - `static readonly viewType = "polylog.compare"`
    - `constructor(deps: { context: vscode.ExtensionContext; store: CompareStore; log: LogView })`
    - `open(opts?: { left?: string }): Promise<void>` — reveals the one panel or creates it
    - `onMessage(m: CompareWebview): Promise<void>`
    - `snapshot(): CompareSnapshot`
  - `interface CompareSnapshot { open: boolean; panels: number /* panels created so far */; title: string; pair: Pair | null; mode: CompareMode; message: string | undefined; summary: string; rows: string[]; missing: string[]; selected: string | undefined; left: string[]; right: string[]; duplicates: string[] }` — `left`/`right` are file lines `"limit.go +1 −0"` (`+ " both"` when tagged; `"binary"` for null counts) or commit subjects.
  - Commands: `polylog.compareBranches`, `polylog.compareWith`; seams `polylog._itest.compare` (snapshot), `polylog._itest.compareSend` (message).
  - workspaceState keys: `polylog.compare.pair`, `polylog.compare.recent`, `polylog.compare.favorites`, `polylog.compare.mode`.

- [ ] **Step 1: Write the failing integration test**

Inside `describe("Compare Branches")`, after the last `it`, add:

```ts
    const panel = () => vscode.commands.executeCommand<import("../comparePanel").CompareSnapshot>("polylog._itest.compare");
    const csend = (m: import("../compareProtocol").CompareWebview) => vscode.commands.executeCommand("polylog._itest.compareSend", m);
    const settled = (what: string, ok: (x: import("../comparePanel").CompareSnapshot) => boolean) =>
      waitFor(what, async () => {
        const x = await panel();
        return ok(x) ? x : undefined;
      });

    it("one Compare tab: Files by default, each side's changes with both marked, a file opens its diff", async () => {
      await vscode.commands.executeCommand("polylog.compareBranches");
      await vscode.commands.executeCommand("polylog.compareBranches");
      let s = await panel();
      assert.strictEqual(s.panels, 1, "a second run reveals the same tab");
      await csend({ type: "pick", pair: { left: "release-1.4", right: "prod" } });
      s = await settled("acme-api detail", (x) => x.selected !== undefined && x.left.length > 0);
      assert.strictEqual(s.title, "⇄ release-1.4 ↔ prod");
      assert.strictEqual(s.mode, "files");
      await csend({ type: "select", repoId: roots["acme-api"] });
      s = await settled("acme-api files", (x) => x.selected === roots["acme-api"] && x.right.length === 3);
      assert.deepStrictEqual(s.left, ["limit.go +1 −0 both", "retry.go +1 −0 both"]);
      assert.deepStrictEqual(s.right, ["limit.go +1 −0 both", "retry.go +1 −0 both", "timeout.go +1 −0"]);
      assert.deepStrictEqual(s.duplicates, ["fix: retry on 503 ◀ ▶"]);
      await csend({ type: "openFile", repoId: roots["acme-api"], side: "right", path: "timeout.go" });
      const tab = await waitFor("a diff", () => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab;
        return t?.input instanceof vscode.TabInputTextDiff ? t.input : undefined;
      });
      assert.strictEqual((await vscode.workspace.openTextDocument(tab.modified)).getText(), "package timeout\n");
      assert.strictEqual((await vscode.workspace.openTextDocument(tab.original)).getText(), "");
      await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    });

    it("Commits mode, swap, the same branch twice, and closing the tab mid-read", async () => {
      await csend({ type: "mode", mode: "commits" });
      await csend({ type: "select", repoId: roots["acme-api"] });
      let s = await settled("commits", (x) => x.mode === "commits" && x.left.length === 1 && x.right.length === 1);
      assert.deepStrictEqual([s.left, s.right], [["feat: rate limit per client"], ["hotfix: raise upstream timeout"]]);
      await csend({ type: "swap" });
      s = await settled("swapped", (x) => x.pair?.left === "prod" && x.left[0] === "hotfix: raise upstream timeout");
      assert.ok(s.rows.includes("acme-api ◀1 ▶1 =1"));
      assert.ok(s.rows.includes("acme-web ◀0 ▶1 =0"), s.rows.join(" | "));
      await csend({ type: "pick", pair: { left: "prod", right: "prod" } });
      s = await settled("same", (x) => x.message !== undefined);
      assert.strictEqual(s.message, "Pick two different branches. Both sides are prod.");
      await csend({ type: "mode", mode: "files" });
      // Close while a read runs: nothing throws, and the next open reads again.
      void csend({ type: "pick", pair: { left: "release-1.4", right: "prod" } });
      await settled("pair saved", (x) => x.pair?.left === "release-1.4");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      s = await settled("closed", (x) => !x.open);
      await vscode.commands.executeCommand("polylog.compareBranches");
      s = await settled("reopened and read", (x) => x.open && x.rows.length === 3);
      assert.strictEqual(s.pair?.left, "release-1.4", "the last pair is remembered");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });
```

- [ ] **Step 2: Run to verify it fails**

Run: `xvfb-run -a npm run test:integration > /tmp/itest.log 2>&1; grep -E "passing|failing" /tmp/itest.log | sed 's/\x1b\[[0-9;]*m//g'`
Expected: 2 failing — `command 'polylog.compareBranches' not found`.

- [ ] **Step 3: Write the protocol and the HTML shell**

Create `src/compareProtocol.ts` with exactly the block in the Interfaces above.

Create `src/webview/compare/html.ts`:

```ts
import type { HtmlOptions } from "../html";

/** The Compare tab's markup; the extension host and the browser harness both render it. */
export function renderCompareHtml(o: HtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; img-src ${o.cspSource}; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${o.styleUri}">
<title>Compare Branches</title>
</head>
<body>
<div id="compare" class="compare">
  <div class="cbar" role="toolbar" aria-label="Compare">
    <div class="cbar-pair">
      <button id="branch-left" class="branch-box left" aria-haspopup="dialog"><span class="side-mark" aria-hidden="true">◀</span><span id="name-left" class="branch-name"></span><span class="caret" aria-hidden="true">▾</span></button>
      <button id="swap" class="icon-button" title="Swap sides" aria-label="Swap sides">⇄</button>
      <button id="branch-right" class="branch-box right" aria-haspopup="dialog"><span class="side-mark" aria-hidden="true">▶</span><span id="name-right" class="branch-name"></span><span class="caret" aria-hidden="true">▾</span></button>
    </div>
    <div class="cbar-show">
      <span class="seg" role="group" aria-label="Show"><button id="mode-files" aria-pressed="true">Files</button><button id="mode-commits" aria-pressed="false">Commits</button></span>
      <button id="refresh" class="icon-button" title="Refresh" aria-label="Refresh">↻</button>
    </div>
    <span id="summary" class="csummary" aria-live="polite"></span>
  </div>
  <div id="message" class="cmessage" hidden></div>
  <div id="cbody" class="cbody">
    <aside class="crepos">
      <div id="repo-list" class="repo-list" role="listbox" tabindex="0" aria-label="Repositories that differ"></div>
      <details id="missing" class="missing" hidden><summary id="missing-title"></summary><ul id="missing-list"></ul></details>
    </aside>
    <section class="cmain">
      <div id="repo-message" class="cmessage" hidden></div>
      <div id="columns" class="columns">
        <div id="col-left" class="column" aria-label="Left only"></div>
        <div id="col-right" class="column" aria-label="Right only"></div>
      </div>
      <details id="dups" class="dups"><summary id="dups-title"></summary><div id="dups-list"></div></details>
    </section>
  </div>
  <div id="picker" class="picker" role="dialog" aria-label="Pick a branch" hidden>
    <input id="picker-search" type="search" placeholder="Search branches" aria-label="Search branches" autocomplete="off" spellcheck="false">
    <div id="picker-items" class="picker-items" role="listbox" aria-label="Branches"></div>
  </div>
</div>
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}
```

Create `src/webview/compare/compare.css` with one line: `:root { color-scheme: normal; }`.

Create `src/webview/compare/main.ts`:

```ts
import "./compare.css";
import type { CompareWebview } from "../../compareProtocol";

declare function acquireVsCodeApi(): { postMessage(m: CompareWebview): void };
const vscodeApi = acquireVsCodeApi();
vscodeApi.postMessage({ type: "ready" });
```

- [ ] **Step 4: Write the panel**

Create `src/comparePanel.ts`:

```ts
import { randomBytes } from "crypto";
import * as path from "path";
import * as vscode from "vscode";
import { COMMIT_PAGE, pairDuplicates, pushRecent, summaryLabel, tabTitle, validPair, type Pair, type Side, type SideCommit } from "./compareModel";
import type { CCommit, CFile, CompareHost, CompareMode, CompareWebview, CRepoRow } from "./compareProtocol";
import { rowLabel, type CompareStore } from "./compareStore";
import type { LogView } from "./logView";
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

  constructor(private readonly deps: { context: vscode.ExtensionContext; store: CompareStore; log: LogView }) {
    this.disposables.push(
      deps.store.onDidChange(() => this.postRepos()),
      deps.log.onDidChangeRefs((id) => void deps.store.refresh(id)),
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
    this.panel?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
```

`panels` in the snapshot is the number of panels ever created: the one-tab test asserts it is 1 right after two `compareBranches` calls (the first `it` of this task runs before any panel was created).

`setPair(pair, false)` on open: the remembered pair is read again (rule 5: nothing is kept between openings).

`this.deps.log.repoList`: `LogView` already exposes `repoList` (used by the Uncommitted view's accents).

When the stored pair has the same name twice (the same-branch message), `store.setPair` reads nothing; `postState` sends the message.

- [ ] **Step 5: Commands, menus, bundle, ship list**

In `src/extension.ts`, after creating `compare`:

```ts
  const comparePanel = new ComparePanel({ context, store: compare, log });
```

add `comparePanel` to `context.subscriptions`, and register:

```ts
    vscode.commands.registerCommand("polylog.compareBranches", () => comparePanel.open()),
    vscode.commands.registerCommand("polylog.compareWith", () => comparePanel.open({ left: log.branchBox || undefined })),
```

and in the `_itest` block:

```ts
      vscode.commands.registerCommand("polylog._itest.compare", () => comparePanel.snapshot()),
      vscode.commands.registerCommand("polylog._itest.compareSend", (m: CompareWebview) => comparePanel.onMessage(m)),
```

In `package.json`:

- `contributes.commands` gains:

```json
      { "command": "polylog.compareBranches", "title": "Compare Branches…", "category": "Polylog", "icon": "$(git-compare)" },
      { "command": "polylog.compareWith", "title": "Compare with…", "category": "Polylog" }
```

- `menus.view/title` gains, before the `polylog.fetchAll` entry:

```json
        { "command": "polylog.compareBranches", "when": "view == polylog.log", "group": "navigation@1" },
```

- `menus.webview/context` gains, after the commit entries:

```json
        { "command": "polylog.compareWith", "when": "webviewId == 'polylog.log' && webviewSection == 'commit'", "group": "0_commit@4" },
```

- `menus.commandPalette` gains `{ "command": "polylog.compareWith", "when": "false" }`.
- `scripts`: add `"bundle:compare": "esbuild src/webview/compare/main.ts --bundle --outfile=out/compare.js --platform=browser --format=iife --target=es2022"`; change `"bundle"` to `"npm run bundle:ext -- --minify && npm run bundle:web -- --minify && npm run bundle:compare -- --minify"` and `"compile"` to `"npm run bundle:ext -- --sourcemap && npm run bundle:web -- --sourcemap && npm run bundle:compare -- --sourcemap"`.

In `.vscodeignore`, after `!out/webview.css`, add:

```
!out/compare.js
!out/compare.css
```

- [ ] **Step 6: Run to verify they pass**

Run: `npm run typecheck && xvfb-run -a npm run test:integration > /tmp/itest.log 2>&1; grep -E "passing|failing" /tmp/itest.log | sed 's/\x1b\[[0-9;]*m//g'`
Expected: `49 passing`, 0 failing.

Mutation checks (one at a time, restore after each):
1. In `onMessage` `case "swap"`, delete `await this.readDetail();` → the swap assertion on `x.left[0]` times out.
2. In `readDetail` files branch, replace `toFile(x, both)` with `toFile(x, new Set())` → the `both` assertions fail.
3. In `open`, remove the `if (this.panel) { this.panel.reveal(); } else` branch so each call creates a panel → `panels` is 2.

- [ ] **Step 7: Commit**

```bash
git add src/comparePanel.ts src/compareProtocol.ts src/webview/compare src/extension.ts package.json .vscodeignore src/integration/log.itest.ts
git commit -m "feat: the Compare tab — one editor tab, Files and Commits, swap, diffs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The Compare tab's page — toolbar, Branch picker, repo list, columns, On both strip

**Files:**
- Modify: `src/webview/compare/main.ts`, `src/webview/compare/compare.css`
- Create: `src/webview/compare/picker.ts`
- Create: `src/webview/accents.css`; Modify: `src/webview/styles.css` (move the `.accent-0` … `.accent-5` rules into `accents.css`, add `@import "./accents.css";` as the file's first line)
- Modify: `dev/harness/build.mjs`, Create: `dev/harness/compareShim.ts`
- Test: browser harness (Playwright), `npm run check:theme`, `npm run check:design`, the Task 3 integration tests (unchanged, must stay green)

**Interfaces:**
- Consumes: `CompareHost`, `CompareWebview`, `CRepoRow`, `CFile`, `CCommit` (Task 3); `pickerGroups`, `PickerItem`, `Pair` (Task 1); `fileTree` (`src/fileTree.ts`); `h`, `clear`, `byId` (`src/webview/dom.ts`); `relativeTime` (`src/webview/view.ts`).
- Produces: `class BranchPicker` in `picker.ts`: `constructor(root: HTMLElement, input: HTMLInputElement, list: HTMLElement, onPick: (item: PickerItem) => void, onFavorite: (name: string) => void)`, `open(anchor: HTMLElement)`, `close()`, `update(names, favorites, recent)`, `get isOpen(): boolean`.

- [ ] **Step 1: Write the harness page (it is the test bench for this task)**

In `dev/harness/build.mjs`, after `writeFileSync(join(dist, "index.html"), html);` add:

```js
const compareBuild = await esbuild.build({
  entryPoints: [join(root, "src/webview/compare/html.ts")], bundle: true, format: "esm", platform: "node", write: false,
});
const { renderCompareHtml } = await import(`data:text/javascript;base64,${Buffer.from(compareBuild.outputFiles[0].text).toString("base64")}`);
writeFileSync(join(dist, "compare.html"), renderCompareHtml({ cspSource: "", nonce: "harness", scriptUri: "compare.js", styleUri: "compare.css" })
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, "")
  .replace("</head>", '<link id="theme" rel="stylesheet" href="themes/dark.css">\n<script src="compareShim.js"></script>\n</head>'));
```

and add two contexts to the `contexts` array:

```js
  esbuild.context({ entryPoints: [join(root, "src/webview/compare/main.ts")], bundle: true, format: "iife", outfile: join(dist, "compare.js"), sourcemap: true }),
  esbuild.context({ entryPoints: [join(here, "compareShim.ts")], bundle: true, format: "iife", outfile: join(dist, "compareShim.js"), sourcemap: true }),
```

and print `compare:  http://localhost:${port}/compare.html?theme=dark` in the `--serve` branch.

Create `dev/harness/compareShim.ts` (mock host, neutral names):

```ts
import type { CompareHost, CompareWebview, CFile, CCommit } from "../../src/compareProtocol";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "dark";
document.addEventListener("DOMContentLoaded", () => document.getElementById("theme")?.setAttribute("href", `themes/${theme}.css`));
const send = (m: CompareHost, ms = 30) => setTimeout(() => window.postMessage(m, "*"), ms);
const f = (path: string, added: number | null, deleted: number | null, both = false): CFile => ({ path, added, deleted, both, status: "M" });
const c = (sha: string, subject: string, author: string, days: number): CCommit => ({ sha: sha.padEnd(40, "0"), parent: "f".repeat(40), subject, author, time: Math.floor(Date.now() / 1000) - days * 86400, files: null });
let pair = { left: "origin/release-1.4", right: "origin/main" };
let mode: "files" | "commits" = "files";
const rows = [
  { repoId: "/work/acme-api", name: "acme-api", accent: 1, status: "differs" as const, left: 2, right: 1, same: 1, behind: true },
  { repoId: "/work/acme-web", name: "acme-web", accent: 2, status: "differs" as const, left: 5, right: 0, same: 0, behind: false },
  { repoId: "/work/acme-legacy", name: "acme-legacy", accent: 3, status: "nobase" as const, left: 0, right: 0, same: 0, behind: false },
  { repoId: "/work/acme-tools", name: "acme-tools", accent: 4, status: "error" as const, left: 0, right: 0, same: 0, reason: "bad object refs/remotes/origin/release-1.4", behind: false },
];
function detail(repoId: string): void {
  if (mode === "files") send({ type: "detail", repoId, mode, left: [f("src/limit.go", 40, 0), f("src/client.go", 3, 1, true), f("assets/logo.png", null, null)], right: [f("src/client.go", 1, 1, true), f("src/timeout.go", 2, 2)], more: { left: false, right: false }, duplicates: [{ subject: "fix: retry on 503", left: "3f9a2c1".padEnd(40, "0"), right: "b71e0d4".padEnd(40, "0") }] });
  else send({ type: "detail", repoId, mode, left: [c("a1", "feat: rate limit per client", "dana", 2), c("a2", "fix: guard nil response", "rin", 3)], right: [c("b1", "hotfix: raise upstream timeout", "dana", 0.2)], more: { left: false, right: false }, duplicates: [{ subject: "fix: retry on 503", left: "3f9a2c1".padEnd(40, "0"), right: "b71e0d4".padEnd(40, "0") }] });
}
function state(): void {
  send({ type: "state", pair, mode, recent: [pair, { left: "origin/release-1.3", right: "origin/prod" }], favorites: ["origin/main"], message: pair.left === pair.right ? `Pick two different branches. Both sides are ${pair.left}.` : undefined });
}
function handle(m: CompareWebview): void {
  console.info("[compare harness]", m);
  switch (m.type) {
    case "ready":
      state();
      send({ type: "branches", names: [{ name: "origin/main", count: 68 }, { name: "main", count: 68 }, { name: "origin/release-1.4", count: 56 }, { name: "origin/release-1.3", count: 56 }, { name: "origin/prod", count: 44 }, { name: "feat/billing", count: 3 }] });
      send({ type: "repos", reading: false, summary: "4 repositories differ · ◀7 ▶1 =1 · 51 identical · 12 missing a branch · in 68 repositories", rows, identical: 51, missing: ["acme-docs", "acme-infra", "acme-ops"] });
      detail("/work/acme-api");
      return;
    case "pick": pair = m.pair; state(); detail("/work/acme-api"); return;
    case "swap": pair = { left: pair.right, right: pair.left }; state(); detail("/work/acme-api"); return;
    case "mode": mode = m.mode; state(); detail("/work/acme-api"); return;
    case "select": detail(m.repoId); return;
    case "expand": send({ type: "commitFiles", repoId: m.repoId, sha: m.sha, files: [f("src/limit.go", 40, 0), f("src/server.go", 6, 1)] }); return;
    default: return;
  }
}
(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: CompareWebview) => setTimeout(() => handle(m), 0) });
```

Run: `npm run harness:build`
Expected: "harness built to …/dev/harness/dist" and `dist/compare.html` exists. Serving it now shows an empty page (Task 3's `main.ts` only posts `ready`) — this is the failing state.

- [ ] **Step 2: Move the accents and write the picker**

Create `src/webview/accents.css` containing the six `.accent-N { --accent: … }` rules cut from `src/webview/styles.css` (lines 223–229 today, including the comment line between `.accent-4` and `.accent-5` if present), and make `@import "./accents.css";` the first line of `styles.css`.

Create `src/webview/compare/picker.ts`:

```ts
import { pickerGroups, type Pair, type PickerItem } from "../../compareModel";
import { clear, h } from "../dom";

/** The Branch picker: a search box over Recent pairs, Favorites, Local and Remote. Filters in the page. */
export class BranchPicker {
  private names: { name: string; count: number }[] = [];
  private favorites: string[] = [];
  private recent: Pair[] = [];
  private items: PickerItem[] = [];
  private active = 0;
  private anchor: HTMLElement | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly input: HTMLInputElement,
    private readonly list: HTMLElement,
    private readonly onPick: (item: PickerItem) => void,
    private readonly onFavorite: (name: string) => void,
  ) {
    input.addEventListener("input", () => {
      this.active = 0;
      this.render();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        this.active = Math.max(0, Math.min(this.items.length - 1, this.active + (e.key === "ArrowDown" ? 1 : -1)));
        this.mark();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const it = this.items[this.active];
        if (it) this.choose(it);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
    list.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the search box
    list.addEventListener("click", (e) => {
      const star = (e.target as Element).closest<HTMLElement>("[data-star]");
      if (star) {
        this.onFavorite(star.dataset.star!);
        return;
      }
      const row = (e.target as Element).closest<HTMLElement>("[data-i]");
      if (row) this.choose(this.items[Number(row.dataset.i)]);
    });
    document.addEventListener("mousedown", (e) => {
      if (this.isOpen && !root.contains(e.target as Node) && !(this.anchor?.contains(e.target as Node) ?? false)) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  update(names: { name: string; count: number }[], favorites: string[], recent: Pair[]): void {
    this.names = names;
    this.favorites = favorites;
    this.recent = recent;
    if (this.isOpen) this.render();
  }

  open(anchor: HTMLElement): void {
    this.anchor = anchor;
    this.root.hidden = false;
    this.root.style.left = `${anchor.offsetLeft}px`;
    this.root.style.top = `${anchor.offsetTop + anchor.offsetHeight + 2}px`;
    this.input.value = "";
    this.active = 0;
    this.render();
    this.input.focus();
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.anchor?.focus();
  }

  private choose(it: PickerItem): void {
    this.close();
    this.onPick(it);
  }

  private render(): void {
    const q = this.input.value;
    const groups = pickerGroups(this.names, this.favorites, this.recent, q);
    this.items = groups.flatMap((g) => g.items);
    clear(this.list);
    if (this.items.length === 0) {
      this.list.append(h("div", { class: "picker-empty" }, [this.names.length === 0 ? "Reading branch names…" : `No branch named "${q.trim()}" in any repository.`]));
      return;
    }
    let i = 0;
    for (const g of groups) {
      this.list.append(h("div", { class: "picker-group", role: "presentation" }, [g.title]));
      for (const it of g.items) {
        const id = `pick-${i}`;
        this.list.append(it.kind === "pair"
          ? h("div", { class: "picker-row", role: "option", id, "data-i": String(i) }, [
            h("span", { class: "side-mark left", "aria-hidden": "true" }, ["◀"]), h("span", { class: "branch-name" }, [it.pair.left]),
            h("span", { class: "side-mark right", "aria-hidden": "true" }, ["▶"]), h("span", { class: "branch-name" }, [it.pair.right]),
          ])
          : h("div", { class: "picker-row", role: "option", id, "data-i": String(i) }, [
            h("button", { class: it.favorite ? "star on" : "star", "data-star": it.name, title: it.favorite ? "Remove from Favorites" : "Add to Favorites", "aria-label": `Favorite ${it.name}`, "aria-pressed": String(it.favorite), tabindex: "-1" }, ["★"]),
            highlight(it.name, q),
            h("span", { class: "picker-count" }, [`in ${it.count} ${it.count === 1 ? "repository" : "repositories"}`]),
          ]));
        i++;
      }
    }
    this.mark();
  }

  private mark(): void {
    for (const el of this.list.querySelectorAll<HTMLElement>("[data-i]")) el.setAttribute("aria-selected", String(Number(el.dataset.i) === this.active));
    const on = this.list.querySelector<HTMLElement>(`[data-i="${this.active}"]`);
    if (on) {
      this.list.setAttribute("aria-activedescendant", on.id);
      on.scrollIntoView({ block: "nearest" });
    }
  }
}

function highlight(name: string, q: string): HTMLElement {
  const i = q.trim() === "" ? -1 : name.toLowerCase().indexOf(q.trim().toLowerCase());
  if (i < 0) return h("span", { class: "branch-name" }, [name]);
  const n = q.trim().length;
  return h("span", { class: "branch-name" }, [name.slice(0, i), h("mark", {}, [name.slice(i, i + n)]), name.slice(i + n)]);
}
```

`root.style.left/top` are set through the style object, which the CSP allows (only style *attributes* in markup are forbidden).

- [ ] **Step 3: Write the page**

Replace `src/webview/compare/main.ts` with:

```ts
import "./compare.css";
import type { CCommit, CFile, CompareHost, CompareMode, CompareWebview, CRepoRow } from "../../compareProtocol";
import type { Duplicate, Pair, PickerItem, Side } from "../../compareModel";
import { fileTree, type TreeNode } from "../../fileTree";
import type { FileChange } from "../../types";
import { byId, clear, h } from "../dom";
import { relativeTime } from "../view";
import { BranchPicker } from "./picker";

declare function acquireVsCodeApi(): { postMessage(m: CompareWebview): void };
const vscodeApi = acquireVsCodeApi();
const post = (m: CompareWebview) => vscodeApi.postMessage(m);

let pair: Pair | null = null;
let mode: CompareMode = "files";
let recent: Pair[] = [];
let favorites: string[] = [];
let names: { name: string; count: number }[] = [];
let rows: CRepoRow[] = [];
let selected: string | undefined;
let detail: Extract<CompareHost, { type: "detail" }> | undefined;
let expanded: { side: Side; sha: string; files?: CFile[] } | undefined;
let pickingSide: Side = "left";

const repoList = byId("repo-list");
const colLeft = byId("col-left");
const colRight = byId("col-right");
const picker = new BranchPicker(byId("picker"), byId<HTMLInputElement>("picker-search"), byId("picker-items"), choose, (name) => post({ type: "favorite", name }));

function choose(it: PickerItem): void {
  if (it.kind === "pair") post({ type: "pick", pair: it.pair });
  else {
    const other = pickingSide === "left" ? pair?.right : pair?.left;
    const next = pickingSide === "left" ? { left: it.name, right: other ?? "" } : { left: other ?? "", right: it.name };
    if (next.left && next.right) post({ type: "pick", pair: next });
    else {
      pair = next;
      renderState();
      openPicker(pickingSide === "left" ? "right" : "left");
    }
  }
}

function openPicker(side: Side): void {
  pickingSide = side;
  if (names.length === 0) post({ type: "wantBranches" });
  picker.open(byId(side === "left" ? "branch-left" : "branch-right"));
}

byId("branch-left").addEventListener("click", () => openPicker("left"));
byId("branch-right").addEventListener("click", () => openPicker("right"));
byId("swap").addEventListener("click", () => post({ type: "swap" }));
byId("refresh").addEventListener("click", () => post({ type: "refresh" }));
byId("mode-files").addEventListener("click", () => post({ type: "mode", mode: "files" }));
byId("mode-commits").addEventListener("click", () => post({ type: "mode", mode: "commits" }));

repoList.addEventListener("click", (e) => {
  const row = (e.target as Element).closest<HTMLElement>("[data-repo]");
  if (row) select(row.dataset.repo!);
});
repoList.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
  e.preventDefault();
  const i = rows.findIndex((r) => r.repoId === selected);
  const to = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : i + (e.key === "ArrowDown" ? 1 : -1);
  const r = rows[Math.max(0, Math.min(rows.length - 1, to))];
  if (r) select(r.repoId);
});

function select(repoId: string): void {
  if (repoId === selected) return;
  selected = repoId;
  expanded = undefined;
  renderRepos();
  post({ type: "select", repoId });
}

for (const [col, side] of [[colLeft, "left"], [colRight, "right"]] as const) {
  col.addEventListener("click", (e) => activate(e.target as Element, side));
  col.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    activate(e.target as Element, side);
  });
}

function activate(target: Element, side: Side): void {
  if (!selected) return;
  const file = target.closest<HTMLElement>("[data-file]");
  if (file) {
    const sha = file.dataset.sha;
    if (sha) post({ type: "openCommitFile", repoId: selected, sha, path: file.dataset.file! });
    else post({ type: "openFile", repoId: selected, side, path: file.dataset.file! });
    return;
  }
  const more = target.closest<HTMLElement>("[data-more]");
  if (more) {
    post({ type: "more", repoId: selected, side });
    return;
  }
  const commit = target.closest<HTMLElement>("[data-commit]");
  if (commit) {
    const sha = commit.dataset.commit!;
    expanded = expanded?.sha === sha ? undefined : { side, sha };
    if (expanded) post({ type: "expand", repoId: selected, sha });
    renderColumns();
  }
}

window.addEventListener("message", (e: MessageEvent<CompareHost>) => {
  const m = e.data;
  switch (m.type) {
    case "state":
      pair = m.pair;
      mode = m.mode;
      recent = m.recent;
      favorites = m.favorites;
      picker.update(names, favorites, recent);
      renderState(m.message);
      if (!pair?.left) openPicker("left");
      else if (!pair.right) openPicker("right");
      return;
    case "branches":
      names = m.names;
      picker.update(names, favorites, recent);
      return;
    case "repos":
      rows = m.rows;
      if (!rows.some((r) => r.repoId === selected)) {
        selected = rows[0]?.repoId;
        detail = undefined;
      }
      byId("summary").textContent = m.summary;
      renderMissing(m.missing);
      renderRepos();
      renderColumns();
      return;
    case "detail":
      if (m.repoId !== selected) return;
      detail = m;
      renderColumns();
      return;
    case "commitFiles":
      if (m.repoId === selected && expanded?.sha === m.sha) {
        expanded.files = m.files;
        renderColumns();
      }
      return;
  }
});

function renderState(message?: string): void {
  byId("name-left").textContent = pair?.left || "Pick a branch";
  byId("name-right").textContent = pair?.right || "Pick a branch";
  byId("mode-files").setAttribute("aria-pressed", String(mode === "files"));
  byId("mode-commits").setAttribute("aria-pressed", String(mode === "commits"));
  const msg = byId("message");
  const text = message ?? (!pair?.left || !pair?.right ? "Pick the branch to merge from (◀) and the branch it goes into (▶)." : undefined);
  msg.hidden = text === undefined;
  msg.textContent = text ?? "";
  byId("cbody").hidden = text !== undefined;
}

function renderMissing(missing: string[]): void {
  const el = byId<HTMLDetailsElement>("missing");
  el.hidden = missing.length === 0 || !pair;
  if (!pair) return;
  byId("missing-title").textContent = `${pair.left} or ${pair.right} is missing in ${missing.length} ${missing.length === 1 ? "repository" : "repositories"}`;
  const list = byId("missing-list");
  clear(list);
  for (const n of missing) list.append(h("li", {}, [n]));
}

function renderRepos(): void {
  clear(repoList);
  const empty = rows.length === 0 && pair && pair.left && pair.right && pair.left !== pair.right;
  const summary = byId("summary").textContent ?? "";
  if (empty) repoList.append(h("div", { class: "cempty" }, [summary.startsWith("Reading") ? "Reading…" : summary.startsWith("No repositories") ? summary : `${pair!.left} and ${pair!.right} are the same in every repository.`]));
  rows.forEach((r, i) => {
    const on = r.repoId === selected;
    repoList.append(h("div", {
      class: on ? "crepo selected" : "crepo", role: "option", id: `crepo-${i}`, "aria-selected": String(on), "data-repo": r.repoId,
      "data-vscode-context": JSON.stringify({ webviewSection: "compareRepo", repoId: r.repoId, behind: r.behind, preventDefaultContextMenuItems: true }),
    }, [
      chip(r),
      r.status === "differs"
        ? h("span", { class: "counts", "aria-label": `${r.left} left only, ${r.right} right only, ${r.same} on both` }, [
          h("span", { class: "left" }, [`◀${r.left}`]), h("span", { class: "right" }, [`▶${r.right}`]), h("span", { class: "same" }, [`=${r.same}`]),
        ])
        : h("span", { class: r.status === "error" ? "row-note error" : "row-note", title: r.reason ?? "" }, [r.status === "nobase" ? "no common history" : "git error"]),
    ]));
  });
  const i = rows.findIndex((r) => r.repoId === selected);
  if (i >= 0) repoList.setAttribute("aria-activedescendant", `crepo-${i}`);
}

function chip(r: CRepoRow): HTMLElement {
  return h("span", { class: `chip accent-${r.accent}`, title: r.name }, [r.name]);
}

function header(side: Side, count: number): HTMLElement {
  const name = side === "left" ? pair?.left ?? "" : pair?.right ?? "";
  const what = mode === "files" ? `${count} ${count === 1 ? "file" : "files"} · since the split` : `${count} ${count === 1 ? "commit" : "commits"} · ${side === "left" ? "the merge brings these in" : `missing from ${pair?.left ?? ""}`}`;
  return h("div", { class: "colhead" }, [h("b", { class: side }, [`${side === "left" ? "◀" : "▶"} ${name} only`]), h("small", {}, [what])]);
}

function renderColumns(): void {
  const row = rows.find((r) => r.repoId === selected);
  const note = byId("repo-message");
  const columns = byId("columns");
  const dups = byId<HTMLDetailsElement>("dups");
  if (row && row.status !== "differs") {
    note.hidden = false;
    columns.hidden = dups.hidden = true;
    note.textContent = row.status === "nobase"
      ? `${row.name}: ${pair?.left} and ${pair?.right} share no history, so there is no split point. Files and Commits need a common ancestor.`
      : `${row.name}: git could not compare the branches: ${row.reason ?? ""}`;
    return;
  }
  note.hidden = !detail?.error;
  note.textContent = detail?.error ? `git could not read ${row?.name ?? "this repository"}: ${detail.error}` : "";
  columns.hidden = dups.hidden = false;
  for (const [col, side] of [[colLeft, "left"], [colRight, "right"]] as const) {
    clear(col);
    const items = detail?.[side] ?? [];
    col.append(header(side, items.length));
    if (!detail) continue;
    if (items.length === 0) {
      col.append(h("div", { class: "cempty" }, [mode === "files" ? "No file changes on this side."
        : side === "left" ? `Nothing here: ${pair?.right} already has every commit of ${pair?.left}.` : `Nothing here: ${pair?.left} has everything on ${pair?.right}.`]));
      continue;
    }
    if (mode === "files") col.append(tree(fileTree((items as CFile[]).map((f): FileChange => ({ ...f }))), items as CFile[], 0));
    else {
      for (const c of items as CCommit[]) col.append(commitRow(c, side));
      if (detail.more[side]) col.append(h("button", { class: "more", "data-more": side }, ["Show 500 more"]));
    }
  }
  renderDups(detail?.duplicates ?? []);
}

function tree(nodes: TreeNode[], files: CFile[], depth: number): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const n of nodes) {
    if (n.kind === "folder") {
      const el = h("div", { class: "trow folder" }, [h("span", { class: "twisty", "aria-hidden": "true" }, ["▾"]), h("span", {}, [n.name]), h("span", { class: "tcount" }, [String(n.count)])]);
      el.style.paddingLeft = `${12 + depth * 14}px`;
      frag.append(el, tree(n.children, files, depth + 1));
    } else {
      const f = files.find((x) => x.path === n.file.path)!;
      const el = h("div", { class: "trow file", tabindex: "0", role: "button", "data-file": f.path, title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path }, [
        h("span", { class: "tname" }, [n.name]),
        f.oldPath ? h("span", { class: "renamed" }, [`← ${f.oldPath}`]) : null,
        f.both ? h("span", { class: "both", title: "Changed on both sides since the split: look at it before merging" }, ["both"]) : null,
        stat(f),
      ]);
      el.style.paddingLeft = `${12 + depth * 14}px`;
      frag.append(el);
    }
  }
  return frag;
}

function stat(f: { added: number | null; deleted: number | null }): HTMLElement {
  return f.added === null ? h("span", { class: "tstat" }, ["binary"]) : h("span", { class: "tstat" }, [h("span", { class: "added" }, [`+${f.added}`]), " ", h("span", { class: "deleted" }, [`−${f.deleted}`])]);
}

function commitRow(c: CCommit, side: Side): HTMLElement {
  const open = expanded?.sha === c.sha && expanded.side === side;
  const now = Date.now() / 1000;
  return h("div", { class: open ? "ccommit open" : "ccommit", tabindex: "0", role: "button", "aria-expanded": String(open), "data-commit": c.sha }, [
    h("div", { class: "csubject" }, [h("span", { class: "twisty", "aria-hidden": "true" }, [open ? "▾" : "▸"]), h("span", {}, [c.subject])]),
    h("div", { class: "cmeta" }, [h("span", {}, [c.author]), h("span", {}, [relativeTime(now, c.time)])]),
    open ? h("div", { class: "cfiles" }, expanded!.files
      ? expanded!.files.map((f) => h("div", { class: "trow file", tabindex: "0", role: "button", "data-file": f.path, "data-sha": c.sha }, [h("span", { class: "tname mono" }, [f.path]), stat(f)]))
      : [h("div", { class: "cempty" }, ["Reading…"])]) : null,
  ]);
}

function renderDups(d: Duplicate[]): void {
  byId("dups-title").textContent = d.length === 0 ? "= none on both"
    : `= ${d.length} on both — the same change committed on each side (cherry-picked): the merge does not repeat it, but history lists it twice`;
  const list = byId("dups-list");
  clear(list);
  for (const x of d) list.append(h("div", { class: "dup" }, [
    h("span", { class: "same" }, ["="]), h("span", {}, [x.subject]),
    x.left ? h("span", { class: "left mono" }, [`◀ ${x.left.slice(0, 7)}`]) : null,
    x.right ? h("span", { class: "right mono" }, [`▶ ${x.right.slice(0, 7)}`]) : null,
  ]));
}

post({ type: "ready" });
```

`relativeTime(now, t)` takes unix seconds for both arguments.

- [ ] **Step 4: Write the styles**

Replace `src/webview/compare/compare.css` with:

```css
@import "../accents.css";

body { margin: 0; padding: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
.compare { display: flex; flex-direction: column; height: 100vh; position: relative; }
.mono, .branch-name { font-family: var(--vscode-editor-font-family); }

.cbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 20px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
.cbar-pair, .cbar-show { display: flex; align-items: center; gap: 6px; }
.csummary { margin-left: auto; color: var(--vscode-descriptionForeground); }
.branch-box { display: inline-flex; align-items: center; gap: 6px; min-width: 150px; padding: 3px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 2px; cursor: pointer; font: inherit; }
.branch-box.left { box-shadow: inset 3px 0 0 var(--vscode-charts-blue); }
.branch-box.right { box-shadow: inset 3px 0 0 var(--vscode-charts-yellow); }
.branch-box .caret { margin-left: auto; color: var(--vscode-descriptionForeground); }
.icon-button { background: transparent; color: var(--vscode-foreground); border: 1px solid transparent; border-radius: 3px; padding: 2px 6px; cursor: pointer; font: inherit; }
.icon-button:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); outline: 1px dashed var(--vscode-contrastActiveBorder, transparent); }
.seg { display: inline-flex; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; overflow: hidden; }
.seg button { background: transparent; color: var(--vscode-foreground); border: 0; padding: 3px 10px; cursor: pointer; font: inherit; }
.seg button[aria-pressed="true"] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); box-shadow: inset 0 -2px 0 var(--vscode-focusBorder); }
button:focus-visible, [tabindex]:focus-visible, input:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

.side-mark.left, .left { color: var(--vscode-charts-blue); }
.side-mark.right, .right { color: var(--vscode-charts-yellow); }
.same, .both { color: var(--vscode-charts-green); }
.added { color: var(--vscode-gitDecoration-addedResourceForeground); }
.deleted { color: var(--vscode-gitDecoration-deletedResourceForeground); }
.error { color: var(--vscode-errorForeground); }

.cmessage { padding: 24px 16px; text-align: center; color: var(--vscode-descriptionForeground); }
.cbody { flex: 1; display: flex; min-height: 0; }
.cbody[hidden], .columns[hidden], .dups[hidden] { display: none; }
.crepos { width: 240px; flex: none; display: flex; flex-direction: column; border-right: 1px solid var(--vscode-panel-border); }
.repo-list { flex: 1; overflow: auto; }
.crepo { display: flex; align-items: center; gap: 8px; padding: 4px 10px; cursor: pointer; white-space: nowrap; }
.crepo:hover { background: var(--vscode-list-hoverBackground); }
.crepo.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); outline: 1px dotted var(--vscode-contrastActiveBorder, transparent); outline-offset: -1px; }
.crepo.selected .counts span, .crepo.selected .row-note { color: inherit; }
.chip { color: var(--accent); border: 1px solid currentColor; border-radius: 3px; padding: 0 6px; overflow: hidden; text-overflow: ellipsis; }
.crepo.selected .chip { color: inherit; }
.counts { margin-left: auto; display: flex; gap: 6px; font-family: var(--vscode-editor-font-family); }
.row-note { margin-left: auto; color: var(--vscode-descriptionForeground); }
.missing { border-top: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
.missing summary { padding: 6px 10px; cursor: pointer; }
.missing ul { margin: 0; padding: 0 10px 8px 28px; max-height: 120px; overflow: auto; }

.cmain { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.columns { flex: 1; display: grid; grid-template-columns: 1fr 1fr; min-height: 0; }
.column { overflow: auto; border-right: 1px solid var(--vscode-panel-border); }
.column:last-child { border-right: 0; }
.colhead { position: sticky; top: 0; z-index: 1; display: flex; gap: 8px; align-items: baseline; padding: 8px 12px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
.colhead small { color: var(--vscode-descriptionForeground); }
.cempty { padding: 24px 16px; text-align: center; color: var(--vscode-descriptionForeground); }
.trow { display: flex; align-items: center; gap: 8px; padding: 2px 12px; line-height: 22px; white-space: nowrap; }
.trow.file { cursor: pointer; }
.trow.file:hover { background: var(--vscode-list-hoverBackground); }
.trow .tcount, .trow .tstat { margin-left: auto; color: var(--vscode-descriptionForeground); }
.trow .tstat .added, .trow .tstat .deleted { font-family: var(--vscode-editor-font-family); }
.renamed { color: var(--vscode-descriptionForeground); }
.both { border: 1px solid currentColor; border-radius: 3px; padding: 0 4px; font-family: var(--vscode-editor-font-family); }
.twisty { width: 12px; color: var(--vscode-descriptionForeground); }
.ccommit { padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border); cursor: pointer; }
.ccommit:hover { background: var(--vscode-list-hoverBackground); }
.csubject { display: flex; gap: 6px; }
.cmeta { display: flex; gap: 12px; margin-left: 18px; color: var(--vscode-descriptionForeground); }
.cfiles { margin: 4px 0 0 12px; }
.more { margin: 8px 12px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, transparent); padding: 3px 10px; cursor: pointer; font: inherit; }
.dups { border-top: 1px solid var(--vscode-panel-border); }
.dups summary { padding: 6px 12px; cursor: pointer; }
.dup { display: flex; gap: 12px; padding: 3px 12px 3px 28px; }

.picker { position: absolute; z-index: 5; width: 380px; background: var(--vscode-quickInput-background); color: var(--vscode-quickInput-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); box-shadow: 0 4px 16px var(--vscode-widget-shadow); }
.picker[hidden] { display: none; }
.picker input { box-sizing: border-box; width: calc(100% - 16px); margin: 8px; padding: 4px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground, var(--vscode-foreground)); border: 1px solid var(--vscode-focusBorder); font: inherit; }
.picker-items { max-height: 320px; overflow: auto; padding-bottom: 6px; }
.picker-group { padding: 6px 12px 2px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
.picker-row { display: flex; align-items: center; gap: 6px; padding: 3px 12px; cursor: pointer; }
.picker-row[aria-selected="true"] { background: var(--vscode-quickInputList-focusBackground, var(--vscode-list-activeSelectionBackground)); color: var(--vscode-quickInputList-focusForeground, var(--vscode-list-activeSelectionForeground)); outline: 1px dotted var(--vscode-contrastActiveBorder, transparent); outline-offset: -1px; }
.picker-row[aria-selected="true"] .picker-count, .picker-row[aria-selected="true"] .side-mark { color: inherit; }
.picker-count { margin-left: auto; color: var(--vscode-descriptionForeground); }
.picker mark { background: transparent; color: var(--vscode-list-highlightForeground); font-weight: 600; }
.picker-row[aria-selected="true"] mark { color: inherit; text-decoration: underline; }
.star { background: transparent; border: 0; padding: 0; cursor: pointer; color: var(--vscode-descriptionForeground); font: inherit; }
.star.on { color: var(--vscode-charts-yellow); }
.picker-empty { padding: 16px 12px; color: var(--vscode-descriptionForeground); }
```

The `.picker-group` 11 px matches VS Code's own section headers; if `check:design` flags it as tiny text, raise it to 12 px rather than ignoring the rule.

- [ ] **Step 5: Check it in the browser harness and with the checks**

Run: `npm run typecheck && npm run check:theme && npm run check:design && npm run harness:build`
Expected: no errors; "theme tokens: clean"; the impeccable detector reports nothing new under `src/webview/compare`.

Run `npm run harness` in the background and open `http://localhost:5178/compare.html?theme=dark` with Playwright. Evaluate:

```js
async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  await w(300);
  const out = {};
  out.rows = [...document.querySelectorAll(".crepo")].map((e) => e.innerText.replace(/\n/g, " "));
  out.left = document.querySelector("#col-left").innerText.slice(0, 80);
  out.both = document.querySelectorAll("#col-left .both").length;
  document.querySelector("#branch-right").click(); await w(50);
  out.pickerOpen = !document.querySelector("#picker").hidden;
  const q = document.querySelector("#picker-search"); q.value = "rel"; q.dispatchEvent(new Event("input")); await w(30);
  out.filtered = [...document.querySelectorAll("#picker-items .branch-name")].map((e) => e.innerText);
  q.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); await w(30);
  out.focusBack = document.activeElement.id;
  document.querySelector("#mode-commits").click(); await w(100);
  document.querySelector("#col-left [data-commit]").click(); await w(100);
  out.expanded = document.querySelectorAll("#col-left .cfiles .trow").length;
  document.querySelector('[data-repo="/work/acme-legacy"]').click(); await w(50);
  out.nobase = document.querySelector("#repo-message").innerText;
  return out;
}
```

Expected: `rows` has 4 entries (acme-api `◀2 ▶1 =1`, acme-web, acme-legacy "no common history", acme-tools "git error"); `both` = 1; `pickerOpen` true; `filtered` = `["origin/release-1.4", "origin/release-1.3"]`; `focusBack` = `"branch-right"`; `expanded` = 2; `nobase` starts with "acme-legacy:". Take screenshots of `?theme=dark`, `?theme=light`, `?theme=hc-dark`, `?theme=hc-light` (save under the repository root, read them, then delete them) and confirm: counts, chips, both tags and selection are readable in all four; high contrast shows outlines on the selected row and the focused control.

- [ ] **Step 6: The integration tests still pass, and the repo menu works in the tab**

Add to `package.json` `menus.webview/context` (after the `uncommitted` repository entries):

```json
        { "command": "polylog.repoPull", "when": "webviewId == 'polylog.compare' && webviewSection == 'compareRepo' && behind", "group": "0_sync@1" },
        { "command": "polylog.repoShowOnly", "when": "webviewId == 'polylog.compare' && webviewSection == 'compareRepo'", "group": "1_filter@1" },
        { "command": "polylog.repoHide", "when": "webviewId == 'polylog.compare' && webviewSection == 'compareRepo'", "group": "1_filter@2" },
        { "command": "polylog.repoOpenFolder", "when": "webviewId == 'polylog.compare' && webviewSection == 'compareRepo'", "group": "2_open@1" },
        { "command": "polylog.repoCopyPath", "when": "webviewId == 'polylog.compare' && webviewSection == 'compareRepo'", "group": "3_copy@1" },
```

Add to the first Task 3 `it` (after the `panels` assertion):

```ts
      const menus = vscode.extensions.getExtension("lntvan166.polylog-git")!.packageJSON.contributes.menus["webview/context"] as { command: string; when: string }[];
      for (const c of ["polylog.repoPull", "polylog.repoShowOnly", "polylog.repoHide", "polylog.repoOpenFolder", "polylog.repoCopyPath"]) {
        assert.ok(menus.some((m) => m.command === c && m.when.includes("polylog.compare")), `${c} on a Compare repo row`);
      }
```

Run: `xvfb-run -a npm run test:integration > /tmp/itest.log 2>&1; grep -E "passing|failing" /tmp/itest.log | sed 's/\x1b\[[0-9;]*m//g'`
Expected: `49 passing`.

- [ ] **Step 7: Commit**

```bash
git add src/webview/compare src/webview/accents.css src/webview/styles.css dev/harness/build.mjs dev/harness/compareShim.ts package.json src/integration/log.itest.ts
git commit -m "feat: the Compare tab's page — Branch picker, repo list, Files and Commits columns, On both

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Freshness — Fetch All, Pull and moved branches read again

**Files:**
- Modify: `src/comparePanel.ts` (debounce per-repository refreshes)
- Test: `src/integration/log.itest.ts` (inside `describe("Compare Branches")`)

**Interfaces:**
- Consumes: `LogView.onDidChangeRefs` (Task 2), `CompareStore.refresh` (Task 2), `debounce` (`src/debounce.ts`: `debounce(fn, ms)` returns a callable with `.cancel()`).
- Produces: no new API.

- [ ] **Step 1: Write the failing test**

Inside `describe("Compare Branches")`, add:

```ts
    it("a branch that moves is read again; Fetch All reads every repository again", async () => {
      await vscode.commands.executeCommand("polylog.compareBranches");
      await csend({ type: "pick", pair: { left: "release-1.4", right: "prod" } });
      await settled("read", (x) => x.rows.includes("acme-web ◀1 ▶0 =0"));
      const web = roots["acme-web"];
      const tip = git(web, ["rev-parse", "refs/heads/release-1.4"]);
      git(web, ["update-ref", "refs/heads/release-1.4", commitOn(web, tip, { "export.ts": "export {};\n" }, "feat: export CSV", T + 60)]);
      await vscode.commands.executeCommand("polylog.fetchAll");
      await settled("re-read after Fetch All", (x) => x.rows.includes("acme-web ◀2 ▶0 =0"));
      git(web, ["update-ref", "refs/heads/release-1.4", tip]);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    });
```

(Fixture repositories have no remote, so Fetch All fetches nothing and finishes at once; it still fires the refs event.)

- [ ] **Step 2: Run to verify it fails or passes for the right reason**

Run: `xvfb-run -a npm run test:integration > /tmp/itest.log 2>&1; grep -E "passing|failing" /tmp/itest.log | sed 's/\x1b\[[0-9;]*m//g'`
Expected: PASS already if Task 2's `refsChanged.fire(undefined)` in `fetchAll` and Task 3's subscription work. Then run the mutation: delete the `deps.log.onDidChangeRefs(...)` subscription in the `ComparePanel` constructor → the test must FAIL ("re-read after Fetch All" times out). Restore. If it does not fail, the test is wrong: fix the test.

- [ ] **Step 3: Debounce per-repository refreshes**

vscode.git reports a repository several times in a burst. In `ComparePanel`, replace the subscription `deps.log.onDidChangeRefs((id) => void deps.store.refresh(id))` with:

```ts
      deps.log.onDidChangeRefs((id) => {
        if (id === undefined) {
          this.touched.clear();
          void deps.store.refresh();
          return;
        }
        this.touched.add(id);
        this.refreshSoon();
      }),
```

and add the fields:

```ts
  private readonly touched = new Set<string>();
  private readonly refreshSoon = debounce(() => {
    const ids = [...this.touched];
    this.touched.clear();
    for (const id of ids) void this.deps.store.refresh(id);
  }, 400);
```

In `dispose()`, add `this.refreshSoon.cancel();`. Import `debounce` from `./debounce`. (Field initialisers run before the constructor body, so `refreshSoon` exists when the subscription is created.)

- [ ] **Step 4: Run the full suite**

Run: `npm test >/dev/null 2>&1; echo unit=$?; npm run lint 2>&1 | grep -E " error "; npm run typecheck; xvfb-run -a npm run test:integration > /tmp/itest.log 2>&1; grep -E "passing|failing" /tmp/itest.log | sed 's/\x1b\[[0-9;]*m//g'`
Expected: `unit=0`, no lint errors, `50 passing`.

- [ ] **Step 5: Commit**

```bash
git add src/comparePanel.ts src/integration/log.itest.ts
git commit -m "feat: the Compare tab reads again after Fetch All, a pull or a moved branch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Performance, docs, UI Map, and the full gate

**Files:**
- Modify: `src/integration/perf.itest.ts`
- Modify: `README.md`, `CLAUDE.md`, `dev/ui-map/index.html`
- Test: `xvfb-run -a npm run perf:startup`; the full gate on stable and 1.85

**Interfaces:**
- Consumes: the seams `polylog._itest.comparePick`, `polylog._itest.compareStore` (Task 2).
- Produces: `PERF` JSON gains `compare: { msCounts, msLong, spawnsByCmd }`.

- [ ] **Step 1: Measure**

In `src/integration/perf.itest.ts`, before the final `console.log("PERF " + …)`, add:

```ts
    // Compare Branches: counts in every repository for a small and a whole-history divergence.
    const roots = settled.repos.map((r) => r.root);
    for (const root of roots) {
      const head = cp.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
      const back = cp.spawnSync("git", ["rev-parse", "HEAD~3"], { cwd: root }).stdout.toString().trim() || head;
      const first = cp.execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: root }).toString().trim().split("\n")[0];
      cp.execFileSync("git", ["update-ref", "refs/heads/perf-right", head], { cwd: root });
      cp.execFileSync("git", ["update-ref", "refs/heads/perf-left", back], { cwd: root });
      cp.execFileSync("git", ["update-ref", "refs/heads/perf-root", first], { cwd: root });
    }
    const compareRead = async (left: string) => {
      const before = (await snapshot())!.spawnLog.length;
      const t = Date.now();
      await vscode.commands.executeCommand("polylog._itest.comparePick", { left, right: "perf-right" });
      const ms = Date.now() - t;
      const log = (await snapshot())!.spawnLog.slice(before);
      return { ms, spawnsByCmd: log.reduce<Record<string, number>>((m, x) => ({ ...m, [x.cmd]: (m[x.cmd] ?? 0) + 1 }), {}) };
    };
    const small = await compareRead("perf-left");
    const long = await compareRead("perf-root");
    await vscode.commands.executeCommand("polylog._itest.comparePick", null);
    for (const root of roots) for (const b of ["perf-left", "perf-right", "perf-root"]) cp.spawnSync("git", ["update-ref", "-d", `refs/heads/${b}`], { cwd: root });
```

and add `compare: { msCounts: small.ms, msLong: long.ms, spawnsByCmd: small.spawnsByCmd }` to the `PERF` object. (`cp` is already required earlier in this test; reuse it.)

Run: `xvfb-run -a npm run perf:startup 2>&1 | grep PERF | tail -1`
Expected: a `compare` entry. Budget: `msCounts` ≤ about 500 ms on 68 repositories. Record `msCounts`, `msLong` and spawns in the ledger. If `msLong` is several times `msCounts` because of `--cherry-mark`, record a ruling (the spec's fallback, a second pass for `=`, is then a follow-up, not this plan).

- [ ] **Step 2: Docs**

README — add after the Uncommitted section:

```markdown
## Compare Branches

**⇄ Compare Branches…** (Log toolbar or Command Palette) opens a tab that compares two branches
in every ticked repository — for example `origin/release-1.4` (◀ left, what you merge from) and
`origin/main` (▶ right, where it goes):

- **◀ left only** — commits the merge brings in;
- **▶ right only** — commits on the target the release does not have (a hotfix never brought back);
- **= on both** — the same change committed on each side (a cherry-pick).

Repositories where the branches are the same are hidden; ones that lack a branch are listed at
the bottom. **Files** (the default) shows each side's changes since the branches split as a
folder tree — a file changed on both sides is marked **both** — and **Commits** lists them commit
by commit. Click a file to open its diff.
```

CLAUDE.md — in "What This Project Does", change "(and, later, of two branches)" to "and a comparison of two branches across repositories".

UI Map (`dev/ui-map/index.html`): replace the planned entry 28 "Compare Branches view" and its planned pill with entries for **Compare tab**, **Compare toolbar**, **Branch picker**, **Compare repo list**, **Compare columns**, **On both strip**, **Missing footer** (follow the file's existing `.g` entry markup and numbering; renumber only the new entries 28a–28g if numbers must stay stable), and add **⇄ Compare Branches** to the Log toolbar's description. Open `npm run ui-map` and check every new name copies on click.

- [ ] **Step 3: The full gate**

Run:

```bash
npm test >/dev/null 2>&1; echo unit=$?
npm run lint 2>&1 | grep -cE " error "; npm run typecheck; echo tc=$?
npm run check:theme && npm run check:design; echo theme=$?
npm run check:denylist; echo deny=$?
xvfb-run -a npm run test:integration > /tmp/it.log 2>&1; echo it=$?
POLYLOG_VSCODE_VERSION=1.85.0 xvfb-run -a npm run test:integration > /tmp/it185.log 2>&1; echo it185=$?
npm run bundle && npx --yes @vscode/vsce ls 2>/dev/null | sort
```

Expected: `unit=0`, `0` lint errors, `tc=0`, `theme=0`, `deny=0`, `it=0`, `it185=0`; `vsce ls` lists the previous 10 files plus `out/compare.js` and `out/compare.css` (12).

- [ ] **Step 4: Commit**

```bash
git add src/integration/perf.itest.ts README.md CLAUDE.md dev/ui-map/index.html
git commit -m "docs: Compare Branches in the README and the UI Map; perf of the counts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
