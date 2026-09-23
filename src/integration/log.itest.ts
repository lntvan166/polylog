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
const ALL = { text: "", author: "", repoIds: null, date: "all" as const };

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

  it("filters by author, alone and together with search", async () => {
    await send({ type: "filter", filter: { ...ALL, author: "DANA" } });
    let s = await until("dana's three commits", (x) => x.rows.length === 3);
    assert.ok(s.rows.every((r) => r.author === "dana"));
    await send({ type: "filter", filter: { ...ALL, author: "rin@example.com", text: "acme-7" } });
    s = await until("rin's ACME-7 commits", (x) => x.rows.length === 2 && x.rows.every((r) => r.author === "rin"));
    await send({ type: "filter", filter: { ...ALL, author: "dana", text: "acme-7" } });
    await until("no rows: dana never mentions ACME-7", (x) => x.rows.length === 0);
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("offers the user's own git email as the Me author", async () => {
    const s = await snapshot();
    assert.strictEqual(s.me, "dana@example.com");
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

  it("an unknown selection cannot leave the tree stuck loading", async () => {
    const c = bySubject(await snapshot(), "chore: bump deps");
    // Not awaited: the bad select arrives while c's detail is in flight.
    void send({ type: "select", repoId: c.repoId, sha: c.sha });
    await send({ type: "select", repoId: c.repoId, sha: "f".repeat(40) });
    await sleep(800);
    const s = await snapshot();
    assert.notStrictEqual(s.changes.message, "Loading changed files…", "the in-flight detail was killed by a select that was never valid");
    assert.ok(s.changes.items[0]?.startsWith("chore: bump deps"));
  });

  it("clears the tree when the selected commit leaves the list", async () => {
    const c = bySubject(await snapshot(), "fix: guard nil");
    await send({ type: "select", repoId: c.repoId, sha: c.sha });
    await send({ type: "filter", filter: { ...ALL, text: "no commit says this" } });
    const s = await until("zero rows", (x) => x.rows.length === 0);
    assert.strictEqual(s.changes.message, "Select a commit in the Log to see its changed files.");
    assert.deepStrictEqual(s.changes.items, []);
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("colors tree files by what the commit did to them", async () => {
    const retry = bySubject(await snapshot(), "feat: add retry");
    await send({ type: "select", repoId: retry.repoId, sha: retry.sha });
    let s = await until("retry decorations", (x) => x.changes.decorations.length > 0 && x.changes.items[0].startsWith("feat: add retry"));
    assert.deepStrictEqual(s.changes.decorations, ["upload.go M gitDecoration.modifiedResourceForeground"]);
    const root = bySubject(s, "feat: scaffold api");
    await send({ type: "select", repoId: root.repoId, sha: root.sha });
    s = await until("root decorations", (x) => x.changes.items[0]?.startsWith("feat: scaffold api") && x.changes.decorations.length > 0);
    assert.deepStrictEqual(s.changes.decorations, ["upload.go A gitDecoration.addedResourceForeground"]);
  });

  it("tree files are not worktree URIs (no live git or Problems decorations)", async () => {
    const c = bySubject(await snapshot(), "feat: add retry");
    await send({ type: "select", repoId: c.repoId, sha: c.sha });
    const s = await until("the retry tree", (x) => x.changes.items.some((i) => i.includes("upload.go")));
    assert.ok(s.changes.schemes.length > 0);
    assert.ok(s.changes.schemes.every((sc) => sc !== "file"), `worktree file: URIs attract live decorations: ${s.changes.schemes}`);
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
