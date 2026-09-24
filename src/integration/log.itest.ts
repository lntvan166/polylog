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
const ALL = { text: "", author: "", mine: false, branch: "", repoIds: null, date: "all" as const };

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

  it("remembers the Repositories pane width the user dragged to", async () => {
    assert.strictEqual((await snapshot()).layout.repoPaneWidth, 190, "default width");
    await send({ type: "layout", repoPaneWidth: 240 });
    assert.strictEqual((await snapshot()).layout.repoPaneWidth, 240);
    await send({ type: "layout", repoPaneWidth: Number.NaN });
    assert.strictEqual((await snapshot()).layout.repoPaneWidth, 240, "a bad width from the webview is ignored");
  });

  it("Group by Repository is on by default and can be turned off and on", async () => {
    assert.strictEqual((await snapshot()).layout.groupByRepo, true);
    await vscode.commands.executeCommand("polylog.hideRepos");
    assert.strictEqual((await snapshot()).layout.groupByRepo, false);
    await vscode.commands.executeCommand("polylog.showRepos");
    assert.strictEqual((await snapshot()).layout.groupByRepo, true);
  });

  it("Me means each repository's own user.email", async () => {
    await until("identities read", (x) => x.me.length === 3);
    await send({ type: "filter", filter: { ...ALL, mine: true } });
    const s = await until("my commits", (x) => x.rows.length === 3);
    // acme-libs has a repo-local identity (rin); the others use the global one (dana).
    assert.deepStrictEqual(s.rows.map((r) => r.subject), ["docs: link ACME-7 from the changelog", "fix: guard nil response", "feat: scaffold api"]);
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("hiding the Repositories pane clears its repo filter", async () => {
    const web = (await snapshot()).repos.find((r) => r.name === "acme-web")!;
    await send({ type: "filter", filter: { ...ALL, repoIds: [web.id] } });
    await until("acme-web only", (x) => x.rows.length === 2);
    await vscode.commands.executeCommand("polylog.hideRepos");
    const s = await until("every repo again", (x) => x.rows.length === 6);
    assert.strictEqual(s.filter.repoIds, null, "no invisible filter left behind");
    await vscode.commands.executeCommand("polylog.showRepos");
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

  it("Open File on a diff opens the file as it is in the workspace now", async () => {
    await closeEditors();
    const c = bySubject(await snapshot(), "feat: scaffold api");
    await vscode.commands.executeCommand("polylog.openDiff", args(c, "upload.go"));
    const input = await diffTab();
    // The editor title button passes the diff's modified side.
    await vscode.commands.executeCommand("polylog.openWorkingFile", input.modified);
    const editor = await waitFor("the workspace file", () => {
      const e = vscode.window.activeTextEditor;
      return e?.document.uri.scheme === "file" ? e : undefined;
    });
    const api = (await snapshot()).repos.find((r) => r.name === "acme-api")!;
    assert.strictEqual(editor.document.uri.fsPath, require("path").join(api.root, "upload.go"));
    assert.match(editor.document.getText(), /func Retry/, "today's content, not the revision's");
  });

  it("Open File from a Changes file's right-click opens the workspace file", async () => {
    await closeEditors();
    const c = bySubject(await snapshot(), "fix: guard nil");
    await send({ type: "select", repoId: c.repoId, sha: c.sha });
    await until("the tree for that commit", (x) => x.changes.items.some((i) => i.includes("client.ts")));
    // The tree passes its file node, as for File History.
    await vscode.commands.executeCommand("polylog.openWorkingFile", { kind: "file", path: "client.ts" });
    const editor = await waitFor("the workspace file", () => {
      const e = vscode.window.activeTextEditor;
      return e?.document.uri.scheme === "file" ? e : undefined;
    });
    assert.match(editor.document.uri.fsPath, /acme-web[\\/]client\.ts$/);
    await closeEditors();
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

  it("File History lists one file's commits and the diff follows the selection", async () => {
    await closeEditors();
    await send({ type: "filter", filter: { ...ALL, date: "7d" } });
    const api = (await snapshot()).repos.find((r) => r.name === "acme-api")!;
    await vscode.commands.executeCommand("polylog.fileHistory", vscode.Uri.file(require("path").join(api.root, "upload.go")));
    let s = await until("upload.go history", (x) => x.history?.path === "upload.go" && x.rows.length === 2);
    assert.strictEqual(s.filter.date, "all", "file history shows all time");
    assert.deepStrictEqual(s.rows.map((r) => r.subject), ["feat: add retry to uploader (ACME-7)", "feat: scaffold api"]);
    // Opening a history shows its newest revision straight away (the Log selects row 0).
    await until("the newest revision is shown", (x) => x.changes.items[0]?.startsWith("feat: add retry") === true);
    const older = s.rows[1];
    await send({ type: "select", repoId: older.repoId, sha: older.sha });
    const input = await waitFor("the older revision's diff", () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return tab instanceof vscode.TabInputTextDiff && tab.modified.scheme === "polylog" && tab.modified.query.includes(older.sha) ? tab : undefined;
    });
    assert.strictEqual((await vscode.workspace.openTextDocument(input.modified)).getText(), "package upload\n");
    await until("the file is highlighted in Changes", (x) => x.changes.focused === "upload.go" && x.changes.items[0]?.startsWith("feat: scaffold api") === true);
    await send({ type: "exitHistory" });
    s = await until("all commits again", (x) => x.history === null);
    assert.strictEqual(s.filter.date, "7d", "closing the history restores the previous date range");
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
    await closeEditors();
  });

  it("File History shows every commit of the file, whatever the search and author, and gives them back on close", async () => {
    await send({ type: "filter", filter: { ...ALL, text: "retry", author: "rin", mine: true } });
    await until("the filtered log", (x) => x.filter.text === "retry");
    const api = (await snapshot()).repos.find((r) => r.name === "acme-api")!;
    await vscode.commands.executeCommand("polylog.fileHistory", vscode.Uri.file(require("path").join(api.root, "upload.go")));
    let s = await until("upload.go history", (x) => x.history?.path === "upload.go" && x.rows.length === 2);
    assert.deepStrictEqual(s.rows.map((r) => r.subject), ["feat: add retry to uploader (ACME-7)", "feat: scaffold api"], "dana's commit shows too, and so does the one that never says retry");
    assert.deepStrictEqual([s.filter.text, s.filter.author, s.filter.mine], ["", "", false], "the boxes are empty while in the history");
    assert.deepStrictEqual([s.persistedFilter?.text, s.persistedFilter?.author, s.persistedFilter?.mine], ["retry", "rin", true], "a reload now would bring the user's filters back");
    await send({ type: "exitHistory" });
    s = await until("all commits again", (x) => x.history === null);
    assert.deepStrictEqual([s.filter.text, s.filter.author, s.filter.mine], ["retry", "rin", true], "closing the history gives the search and author back");
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("stepping through a history keeps one diff tab even with preview editors off", async () => {
    await closeEditors();
    const cfg = vscode.workspace.getConfiguration("workbench.editor");
    await cfg.update("enablePreview", false, vscode.ConfigurationTarget.Global);
    try {
      const api = (await snapshot()).repos.find((r) => r.name === "acme-api")!;
      await vscode.commands.executeCommand("polylog.fileHistory", vscode.Uri.file(require("path").join(api.root, "upload.go")));
      const s = await until("upload.go history", (x) => x.history?.path === "upload.go" && x.rows.length === 2);
      // The Log selects row 0 on its own; on a slow host that can land after a step below.
      await until("the newest revision is shown", (x) => x.changes.items[0]?.startsWith("feat: add retry") === true);
      for (const row of [s.rows[1], s.rows[0], s.rows[1]]) {
        await send({ type: "select", repoId: row.repoId, sha: row.sha });
        await waitFor(`the diff for ${row.subject}`, () => {
          const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
          return tab instanceof vscode.TabInputTextDiff && tab.modified.query.includes(row.sha) ? tab : undefined;
        });
      }
      await sleep(300);
      const diffs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff);
      assert.strictEqual(diffs.length, 1, "each step replaced the previous history diff");
      // Holding ↓/↑: the next step arrives while the previous one is still swapping tabs.
      for (const row of [s.rows[0], s.rows[1], s.rows[0], s.rows[1], s.rows[0]]) await send({ type: "select", repoId: row.repoId, sha: row.sha });
      await sleep(1500);
      const after = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff);
      assert.deepStrictEqual(after.map((t) => (t.input as vscode.TabInputTextDiff).modified.query.includes(s.rows[0].sha)), [true],
        "rapid steps leave exactly one diff tab, showing the last selection");
      await send({ type: "exitHistory" });
      await until("all commits again", (x) => x.history === null);
      // A later File History is a new session: it must not close the diff this one left open.
      const web = (await snapshot()).repos.find((r) => r.name === "acme-web")!;
      await vscode.commands.executeCommand("polylog.fileHistory", vscode.Uri.file(require("path").join(web.root, "client.ts")));
      const w = await until("client.ts history", (x) => x.history?.path === "client.ts" && x.rows.length === 2);
      await until("its newest revision is shown", (x) => x.changes.items[0]?.startsWith("fix: guard nil") === true);
      await send({ type: "select", repoId: w.rows[1].repoId, sha: w.rows[1].sha });
      await sleep(1500);
      const kept = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputTextDiff)
        .map((t) => (t.input as vscode.TabInputTextDiff).modified.path);
      assert.deepStrictEqual(kept.sort(), ["/client.ts", "/upload.go"], "upload.go's diff from the previous session is still open");
      await send({ type: "exitHistory" });
      await until("all commits again", (x) => x.history === null);
    } finally {
      await cfg.update("enablePreview", undefined, vscode.ConfigurationTarget.Global);
      await closeEditors();
    }
  });

  it("File History never overwrites the saved date range, and ends if its repo leaves", async () => {
    await send({ type: "filter", filter: { ...ALL, date: "7d" } });
    const api = (await snapshot()).repos.find((r) => r.name === "acme-api")!;
    await vscode.commands.executeCommand("polylog.fileHistory", vscode.Uri.file(require("path").join(api.root, "upload.go")));
    let s = await until("history", (x) => x.history !== null);
    assert.strictEqual(s.filter.date, "all");
    assert.strictEqual(s.persistedFilter?.date, "7d", "a window reload now would bring back 7 days, not all time");
    const cfg = vscode.workspace.getConfiguration("polylog");
    await cfg.update("excludeRepos", ["acme-api"], vscode.ConfigurationTarget.Global);
    try {
      await send({ type: "refresh" });
      s = await until("history ended", (x) => x.history === null && x.repos.length === 2);
      assert.strictEqual(s.filter.date, "7d", "and the previous range is back");
    } finally {
      await cfg.update("excludeRepos", undefined, vscode.ConfigurationTarget.Global);
      await send({ type: "refresh" });
      await until("three repos again", (x) => x.repos.length === 3);
      await send({ type: "filter", filter: ALL });
      await until("six rows again", (x) => x.rows.length === 6);
    }
  });

  it("a branch is used where it exists, the current branch elsewhere", async () => {
    await send({ type: "filter", filter: { ...ALL, branch: "prod" } });
    const s = await until("prod in acme-api only", (x) => x.rows.length === 5 && x.branchUse?.found === 1);
    assert.deepStrictEqual(s.branchUse, { branch: "prod", found: 1, fallback: 2 });
    assert.ok(!s.rows.some((r) => r.subject.startsWith("feat: add retry")), "acme-api shows prod, which is one commit behind");
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("offers branch names found across repositories", async () => {
    const s = await until("branch suggestions", (x) => x.branches.length > 0);
    assert.deepStrictEqual(s.branches.find((b) => b.name === "main"), { name: "main", count: 3 });
    assert.deepStrictEqual(s.branches.find((b) => b.name === "prod"), { name: "prod", count: 1 });
  });

  it("keeps the Log alive when the panel shows another tab", async () => {
    const before = (await snapshot()).readyCount;
    await vscode.commands.executeCommand("workbench.action.terminal.focus");
    await sleep(500);
    await vscode.commands.executeCommand("polylog.open");
    await sleep(1000);
    assert.strictEqual((await snapshot()).readyCount, before, "the webview was destroyed and re-created");
  });

  it("switching git.path takes effect at once, and a path that cannot run falls back", async function () {
    if (process.platform === "win32") this.skip(); // the wrapper is a shell script
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const os = require("os") as typeof import("os");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-gitpath-"));
    const calls = path.join(dir, "calls.log");
    const wrapper = path.join(dir, "git-wrapper");
    // Records every call, then runs the real git from PATH.
    fs.writeFileSync(wrapper, `#!/bin/sh\necho "$@" >> "${calls}"\nexec git "$@"\n`, { mode: 0o755 });
    const cfg = vscode.workspace.getConfiguration("git");
    const reloads = async () => (await snapshot()).stats.reloads;
    try {
      let before = await reloads();
      await cfg.update("path", wrapper, vscode.ConfigurationTarget.Global);
      let s = await until("a reload through the new git", (x) => x.stats.reloads > before && x.rows.length > 0 && !x.failures.length);
      await waitFor("the wrapper to be used", () => (fs.existsSync(calls) && /log /.test(fs.readFileSync(calls, "utf8")) ? true : undefined));
      assert.ok(s.rows.length > 0, "the Log still lists commits through the wrapper");

      before = await reloads();
      await cfg.update("path", path.join(dir, "no-such-git"), vscode.ConfigurationTarget.Global);
      s = await until("a reload after switching to a path that cannot run", (x) => x.stats.reloads > before && x.rows.length > 0);
      assert.deepStrictEqual(s.failures, [], "falls back to a git that runs instead of failing every repo");

      before = await reloads();
      await cfg.update("path", undefined, vscode.ConfigurationTarget.Global);
      await until("a reload after clearing git.path", (x) => x.stats.reloads > before && x.rows.length > 0);
      fs.writeFileSync(calls, "");
      await send({ type: "refresh" });
      await until("a refresh", (x) => x.rows.length > 0);
      await sleep(300);
      assert.strictEqual(fs.readFileSync(calls, "utf8"), "", "the old git.path is no longer used");
    } finally {
      await cfg.update("path", undefined, vscode.ConfigurationTarget.Global);
    }
  });

  // Last: it leaves Changes hidden for the rest of the session, as a user who hid it wants.
  it("Hide 'Changes' is undone once as an accident, then respected", async () => {
    const c = bySubject(await snapshot(), "feat: add retry");
    await send({ type: "select", repoId: c.repoId, sha: c.sha });
    await until("Changes showing the commit", (x) => x.changesVisible && x.changes.items.some((i) => i.includes("upload.go")));
    await vscode.commands.executeCommand("polylog.changes.removeView");
    await until("the first hide undone", (x) => x.changesVisible);
    await sleep(700); // a person hiding it again; the reveal has finished by then
    await vscode.commands.executeCommand("polylog.changes.removeView");
    await sleep(800);
    assert.strictEqual((await snapshot()).changesVisible, false, "hidden again right away: the user means it");
    await send({ type: "select", repoId: c.repoId, sha: c.sha });
    await sleep(800);
    assert.strictEqual((await snapshot()).changesVisible, false, "and a later selection does not bring it back");
  });
});
