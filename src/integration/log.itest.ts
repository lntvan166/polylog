import * as assert from "assert";
import * as vscode from "vscode";
import type { OpenDiffArgs } from "../changesTree";
import type { LogSnapshot } from "../logView";
import type { WebviewMessage } from "../protocol";
import { UNCOMMITTED, type Commit } from "../types";
import { EXPECTED_ORDER } from "./fixture";

const snapshot = () => vscode.commands.executeCommand<LogSnapshot>("polylog._itest.snapshot");
const send = (m: WebviewMessage) => vscode.commands.executeCommand("polylog._itest.send", m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ALL = { text: "", author: "", mine: false, branch: "", repoIds: null, date: "all" as const };

async function waitFor<T>(what: string, probe: () => PromiseLike<T | undefined> | T | undefined, ms = 20000): Promise<T> {
  const start = Date.now();
  const end = start + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) {
      // On a slow CI runner, name the step that took the time.
      if (Date.now() - start > 3000) console.log(`    (slow wait: ${what}, ${Date.now() - start} ms)`);
      return v;
    }
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
    assert.deepStrictEqual(s.persistedFilter?.repoIds, [web.id], "the ticked repositories are saved for the next window");
    await send({ type: "ready" }); // the webview re-created (a reload, or VS Code dropping it)
    s = await until("the replay", (x) => x.rows.length === 2);
    assert.deepStrictEqual(s.filter.repoIds, [web.id], "and a re-created webview gets them back");
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

  it("several authors: a commit by any of them matches, and the box suggests who committed", async () => {
    await send({ type: "filter", filter: { ...ALL, authors: ["dana"] } });
    await until("dana's three commits", (x) => x.rows.length === 3 && x.rows.every((r) => r.author === "dana"));
    await send({ type: "filter", filter: { ...ALL, authors: ["dana", "rin@example.com"] } });
    await until("dana's and rin's six commits", (x) => x.rows.length === 6);
    await send({ type: "filter", filter: { ...ALL, authors: ["noor"] } });
    await until("nobody named noor", (x) => x.rows.length === 0);
    await send({ type: "filter", filter: ALL });
    await sleep(300);
    assert.strictEqual((await snapshot()).authors.length, 0, "nothing is read until the Author box is focused");
    await send({ type: "wantSuggestions", kind: "authors" });
    const s = await until("author suggestions read", (x) => x.authors.length === 2);
    assert.deepStrictEqual(s.authors.map((a) => [a.name, a.email, a.count]).sort(), [["dana", "dana@example.com", 3], ["rin", "rin@example.com", 3]]);
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("Me is one more author beside the picked ones", async () => {
    await until("identities read", (x) => x.me.length === 3);
    // Me is dana, except in acme-libs where it is rin. So Me plus rin is every commit
    // except dana's one in acme-libs ("chore: bump deps").
    await send({ type: "filter", filter: { ...ALL, mine: true, authors: ["rin"] } });
    const s = await until("my commits and rin's", (x) => x.rows.length === 5);
    assert.ok(!s.rows.some((r) => r.subject === "chore: bump deps"), "dana is not Me in acme-libs");
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("the path filter keeps commits that touched it, in every repository", async () => {
    await send({ type: "filter", filter: { ...ALL, path: "upload.go" } });
    let s = await until("upload.go's commits", (x) => x.rows.length === 2);
    assert.ok(s.rows.every((r) => s.repos.find((p) => p.id === r.repoId)?.name === "acme-api"), "only the repo that has the file");
    await send({ type: "filter", filter: { ...ALL, path: "**/*.md" } });
    s = await until("the markdown commit", (x) => x.rows.length === 1);
    assert.strictEqual(s.rows[0].subject, "docs: link ACME-7 from the changelog", "a glob");
    await send({ type: "filter", filter: { ...ALL, path: "client.ts", authors: ["rin"] } });
    s = await until("rin's commit to client.ts", (x) => x.rows.length === 1);
    assert.strictEqual(s.rows[0].subject, "feat: scaffold web", "path and author together");
    await send({ type: "filter", filter: { ...ALL, path: ":(top)../../etc" } });
    s = await until("an unsafe path ignored", (x) => x.rows.length === 6);
    assert.strictEqual(s.filter.path, undefined, "dropped by the host, never passed to git");
    await send({ type: "filter", filter: { ...ALL, path: "client.ts" } });
    await until("client.ts's commits", (x) => x.rows.length === 2);
    const api = s.repos.find((r) => r.name === "acme-api")!;
    await vscode.commands.executeCommand("polylog.fileHistory", vscode.Uri.file(require("path").join(api.root, "upload.go")));
    s = await until("upload.go history, whatever the path filter", (x) => x.history?.path === "upload.go" && x.rows.length === 2);
    await send({ type: "exitHistory" });
    s = await until("the path filter back", (x) => x.history === null && x.rows.length === 2);
    assert.strictEqual(s.filter.path, "client.ts");
    await send({ type: "filter", filter: ALL });
    await until("six rows again", (x) => x.rows.length === 6);
  });

  it("uncommitted changes: pinned above the commits when the toggle is on, and they follow a save", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    const cfg = vscode.workspace.getConfiguration("polylog");
    await send({ type: "filter", filter: ALL });
    const web = (await until("six rows", (x) => x.rows.length === 6)).repos.find((r) => r.name === "acme-web")!;
    const git = (...args: string[]) => cp.execFileSync("git", args, { cwd: web.root }).toString().trim();
    const head = git("rev-parse", "HEAD");
    fs.writeFileSync(path.join(web.root, "client.ts"), "export const ok = false;\n");
    fs.writeFileSync(path.join(web.root, "notes.md"), "todo\n");
    try {
      await send({ type: "refresh" });
      await sleep(500);
      assert.ok(!(await snapshot()).rows.some((r) => r.sha === UNCOMMITTED), "off by default");
      await cfg.update("showUncommitted", true, vscode.ConfigurationTarget.Global);
      let s = await until("the pinned row", (x) => x.rows[0]?.sha === UNCOMMITTED && x.rows.length === 7);
      assert.deepStrictEqual([s.rows[0].repoId, s.rows[0].uncommitted], [web.id, 2], "one row for the repo with changes, with its file count");

      await send({ type: "select", repoId: web.id, sha: UNCOMMITTED });
      s = await until("its files", (x) => x.changes.items.length === 3);
      assert.deepStrictEqual(s.changes.items.slice(1).sort(), ["  client.ts | +1 −1", "  notes.md | new"]);

      await closeEditors();
      await vscode.commands.executeCommand("polylog.openDiff", { repoId: web.id, sha: UNCOMMITTED, parent: head, path: "client.ts" });
      const input = await waitFor("a working-tree diff", () => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return t instanceof vscode.TabInputTextDiff && t.modified.scheme === "file" ? t : undefined;
      });
      assert.strictEqual(input.modified.scheme, "file", "the right side is the real, editable file");
      assert.strictEqual((await vscode.workspace.openTextDocument(input.original)).getText(), "export const ok = true;\n", "the left side is the last commit");

      // A save in the editor refreshes the row.
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(web.root, "notes.md")));
      fs.writeFileSync(path.join(web.root, "extra.ts"), "x\n");
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(0, 0), "more ");
      await vscode.workspace.applyEdit(edit);
      let mark = await snapshot();
      await doc.save();
      await until("the row after a save", (x) => x.rows[0]?.uncommitted === 3);
      // Only the saved file's repository is read again (VS Code's Git reports it too, a moment later).
      await sleep(1500);
      const statusSince = (from: LogSnapshot, to: LogSnapshot) => to.spawnLog.slice(from.spawnLog.length).filter((x) => x.cmd === "status").map((x) => x.root);
      let now = await snapshot();
      const read = statusSince(mark, now);
      assert.ok(read.length > 0 && read.every((root) => root === web.root), `a save re-reads only its own repository, not all of them (read: ${read.join(", ")})`);

      // A save that changes nothing git reports posts nothing to the Log.
      mark = now;
      const again = new vscode.WorkspaceEdit();
      again.insert(doc.uri, new vscode.Position(0, 0), "x");
      await vscode.workspace.applyEdit(again);
      await doc.save();
      await sleep(1500);
      now = await snapshot();
      assert.ok(statusSince(mark, now).length > 0, "it was read again");
      const posted = (s: LogSnapshot) => (s.posts.page?.count ?? 0) + (s.posts.pinned?.count ?? 0);
      assert.strictEqual(posted(now), posted(mark), "and nothing was posted: the same files, the same counts");

      // A save outside every repository reads nothing. First let VS Code's Git finish reporting
      // the saves above (on a slow runner its report comes seconds later).
      mark = await waitFor("git to go quiet", async () => {
        const a = await snapshot();
        await sleep(1500);
        const b = await snapshot();
        return b.spawnLog.length === a.spawnLog.length ? b : undefined;
      });
      const outside = path.join(require("os").tmpdir(), `polylog-outside-${Date.now()}.txt`);
      fs.writeFileSync(outside, "a\n");
      const other = await vscode.workspace.openTextDocument(vscode.Uri.file(outside));
      const edit3 = new vscode.WorkspaceEdit();
      edit3.insert(other.uri, new vscode.Position(0, 0), "b");
      await vscode.workspace.applyEdit(edit3);
      await other.save();
      await sleep(1000);
      // VS Code's Git may still report acme-web on its own; the other repositories stay unread
      // (before, any save read every repository).
      const outsideRead = statusSince(mark, await snapshot());
      assert.ok(outsideRead.every((root) => root === web.root), `a file outside every repository is not a working-tree change (read: ${outsideRead.join(", ")})`);
      await closeEditors();
      fs.rmSync(outside, { force: true });

      // A date change cannot change the working tree: repositories VS Code's Git reports on are
      // not read again (a late report of acme-web's own saves may still read acme-web).
      mark = await waitFor("git to go quiet", async () => {
        const a = await snapshot();
        await sleep(1500);
        const b = await snapshot();
        return b.spawnLog.length === a.spawnLog.length ? b : undefined;
      });
      assert.ok(mark.reported.length > 0, "VS Code's Git reports on the fixture repositories (else this proves nothing)");
      await send({ type: "filter", filter: { ...ALL, date: "30d" } });
      now = await until("the 30-day page", (x) => x.filter.date === "30d" && x.stats.reloads > mark.stats.reloads);
      await sleep(300);
      const reread = statusSince(mark, await snapshot()).filter((root) => mark.reported.includes(root) && root !== web.root);
      assert.deepStrictEqual(reread, [], "the working tree is not read again for a date change");
      // Where VS Code's Git reports nothing (here git.autorefresh off), no event keeps them
      // current: those repositories are read every time.
      const gitCfg = () => vscode.workspace.getConfiguration("git");
      await gitCfg().update("autorefresh", false, vscode.ConfigurationTarget.Global);
      try {
        mark = await snapshot();
        await send({ type: "filter", filter: { ...ALL, date: "7d" } });
        await until("the 7-day page", (x) => x.filter.date === "7d" && x.stats.reloads > mark.stats.reloads);
        await waitFor("every repository read again", async () => (new Set(statusSince(mark, await snapshot())).size === mark.repos.length ? true : undefined));
      } finally {
        await gitCfg().update("autorefresh", undefined, vscode.ConfigurationTarget.Global);
      }
      await send({ type: "filter", filter: ALL });
      await until("all time again", (x) => x.filter.date === "all" && x.rows[0]?.sha === UNCOMMITTED);
      mark = await snapshot();
      await send({ type: "refresh" });
      await waitFor("Refresh reads it again", async () => (statusSince(mark, await snapshot()).length >= 3 ? true : undefined));

      await send({ type: "filter", filter: { ...ALL, text: "retry" } });
      await until("no pinned row while searching", (x) => x.rows.length === 1 && x.rows[0].sha !== UNCOMMITTED);
      await send({ type: "filter", filter: ALL });
      await until("the pinned row again", (x) => x.rows[0]?.sha === UNCOMMITTED);

      // The toolbar buttons act at once and write the setting back.
      await vscode.commands.executeCommand("polylog.hideUncommitted");
      await until("hidden by the button", (x) => !x.rows.some((r) => r.sha === UNCOMMITTED));
      await waitFor("the setting written back", () => (cfg.get("showUncommitted") === false ? true : undefined));
      await vscode.commands.executeCommand("polylog.showUncommitted");
      await until("shown by the button", (x) => x.rows[0]?.sha === UNCOMMITTED);
      await waitFor("the setting written back", () => (vscode.workspace.getConfiguration("polylog").get("showUncommitted") === true ? true : undefined));
    } finally {
      await cfg.update("showUncommitted", undefined, vscode.ConfigurationTarget.Global);
      await closeEditors();
      git("checkout", "--", ".");
      git("clean", "-fdq");
    }
    await send({ type: "refresh" });
    await until("six rows, no pinned row", (x) => x.rows.length === 6 && !x.rows.some((r) => r.sha === UNCOMMITTED));
  });

  it("Review Uncommitted: every repository's uncommitted files in one tree, then back to the log", async () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const cp = require("child_process") as typeof import("child_process");
    await send({ type: "filter", filter: ALL });
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const api = s0.repos.find((r) => r.name === "acme-api")!;
    const git = (root: string, ...args: string[]) => cp.execFileSync("git", args, { cwd: root }).toString().trim();
    fs.writeFileSync(path.join(web.root, "client.ts"), "export const ok = 1;\n");
    fs.writeFileSync(path.join(api.root, "upload.go"), "package upload\n\nfunc Retry() { retry() }\n");
    fs.writeFileSync(path.join(api.root, "notes.md"), "n\n");
    try {
      await vscode.commands.executeCommand("polylog.reviewUncommitted");
      let s = await until("the review", (x) => x.review && x.rows.length === 2 && x.changes.items.length > 0);
      assert.ok(s.rows.every((r) => r.sha === UNCOMMITTED), "only the repositories with changes, no commits (the rows toggle is off)");
      const roots = (x: LogSnapshot) => x.changes.items.filter((i) => !i.startsWith(" "));
      // The webview selects the first row when the rows arrive: let that land before clicking.
      await until("the webview's own first selection", (x) => roots(x).length === 1);
      // The tree shows the repository clicked in the Log, not all of them.
      await send({ type: "select", repoId: api.id, sha: UNCOMMITTED });
      s = await until("acme-api's files only", (x) => roots(x).length === 1 && roots(x)[0].startsWith("acme-api"));
      assert.deepStrictEqual(roots(s), ["acme-api | 2 files · not committed"]);
      await send({ type: "select", repoId: web.id, sha: UNCOMMITTED });
      s = await until("acme-web's files only", (x) => roots(x).length === 1 && roots(x)[0].startsWith("acme-web"));
      assert.deepStrictEqual(roots(s), ["acme-web | 1 file · not committed"]);
      await send({ type: "select", repoId: api.id, sha: UNCOMMITTED });
      await until("acme-api again", (x) => roots(x)[0]?.startsWith("acme-api") === true);
      await closeEditors();
      await vscode.commands.executeCommand("polylog.openDiff", { repoId: api.id, sha: UNCOMMITTED, parent: git(api.root, "rev-parse", "HEAD"), path: "upload.go" });
      const input = await waitFor("a working-tree diff", () => {
        const t = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return t instanceof vscode.TabInputTextDiff && t.modified.scheme === "file" ? t : undefined;
      });
      assert.match(input.modified.fsPath, /acme-api[\\/]upload\.go$/);
      // A group's file knows its repository: Open File on acme-web's file goes to acme-web.
      await send({ type: "select", repoId: web.id, sha: UNCOMMITTED });
      await until("acme-web shown", (x) => roots(x)[0]?.startsWith("acme-web") === true);
      await vscode.commands.executeCommand("polylog.openWorkingFile", { kind: "file", path: "client.ts", owner: { repoId: web.id, sha: UNCOMMITTED, parent: null } });
      await waitFor("client.ts in acme-web", () => (vscode.window.activeTextEditor?.document.uri.fsPath.endsWith(path.join("acme-web", "client.ts")) ? true : undefined));
      await send({ type: "exitReview" });
      s = await until("the log again", (x) => !x.review && x.rows.length === 6);
      assert.ok(!s.rows.some((r) => r.sha === UNCOMMITTED), "and no pinned rows, since the toggle is off");
    } finally {
      await closeEditors();
      for (const root of [web.root, api.root]) {
        git(root, "checkout", "--", ".");
        git(root, "clean", "-fdq");
      }
    }
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

  it("right-click a repository: Show Only, Hide, Show All, Copy Path, Exclude", async () => {
    await send({ type: "filter", filter: ALL });
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const [web, api, libs] = ["acme-web", "acme-api", "acme-libs"].map((n) => s0.repos.find((r) => r.name === n)!);
    // What VS Code passes from a webview right-click: the element's data-vscode-context.
    const on = (repoId: string, section = "repo") => ({ webviewSection: section, repoId });
    await vscode.commands.executeCommand("polylog.repoShowOnly", on(web.id, "commit"));
    let s = await until("acme-web only", (x) => x.rows.length === 2 && x.rows.every((r) => r.repoId === web.id));
    assert.deepStrictEqual(s.filter.repoIds, [web.id], "from a commit row too, and the filter is the pane's");
    await vscode.commands.executeCommand("polylog.repoShowAll");
    await until("every repository", (x) => x.rows.length === 6 && x.filter.repoIds === null);
    await vscode.commands.executeCommand("polylog.repoHide", on(api.id));
    s = await until("all but acme-api", (x) => x.rows.length > 0 && !x.rows.some((r) => r.repoId === api.id));
    assert.deepStrictEqual(s.filter.repoIds, s0.repos.map((r) => r.id).filter((id) => id !== api.id), "the others stay ticked");
    await vscode.commands.executeCommand("polylog.repoShowAll");
    await until("every repository again", (x) => x.filter.repoIds === null && x.rows.length === 6);
    await vscode.commands.executeCommand("polylog.repoShowOnly", on("/not/a/repo"));
    assert.strictEqual((await snapshot()).filter.repoIds, null, "an id that is not a listed repository is ignored");

    await vscode.commands.executeCommand("polylog.repoCopyPath", on(libs.id));
    assert.strictEqual(await vscode.env.clipboard.readText(), libs.root);

    // With the pane hidden, a commit row's Show Only brings the pane back: no invisible filter.
    await vscode.commands.executeCommand("polylog.hideRepos");
    await vscode.commands.executeCommand("polylog.repoShowOnly", on(web.id, "commit"));
    s = await until("acme-web only, pane shown", (x) => x.filter.repoIds?.length === 1 && x.rows.length === 2);
    assert.strictEqual(s.layout.groupByRepo, true, "the filter is never one the user cannot see");
    await vscode.commands.executeCommand("polylog.repoShowAll");
    await until("every repository", (x) => x.filter.repoIds === null && x.rows.length === 6);

    const cfg = () => vscode.workspace.getConfiguration("polylog");
    // The user's own (global) exclusions stay: arrays do not merge across settings scopes.
    await cfg().update("excludeRepos", ["no-such-repo-*"], vscode.ConfigurationTarget.Global);
    try {
      // Excluding the repo shown alone must not leave a filter that matches nothing.
      await vscode.commands.executeCommand("polylog.repoShowOnly", on(libs.id));
      await until("acme-libs only", (x) => x.filter.repoIds?.[0] === libs.id);
      await vscode.commands.executeCommand("polylog.repoExclude", on(libs.id));
      s = await until("acme-libs left out", (x) => x.repos.length === 2 && !x.repos.some((r) => r.id === libs.id));
      const inspected = cfg().inspect<string[]>("excludeRepos");
      assert.deepStrictEqual(inspected?.globalValue, ["no-such-repo-*", libs.root.replace(/\\/g, "/")], "its exact path, added to the user's own list (not a workspace file inside a repo)");
      assert.strictEqual(inspected?.workspaceValue, undefined);
      s = await until("every remaining repository shown", (x) => x.filter.repoIds === null && x.rows.length > 0);
    } finally {
      await cfg().update("excludeRepos", undefined, vscode.ConfigurationTarget.Global);
    }
    await send({ type: "refresh" });
    await until("three repositories again", (x) => x.repos.length === 3 && x.rows.length === 6);
  });

  it("right-click a commit: Copy Commit ID, Copy Message, Open on Remote", async () => {
    const cp = require("child_process") as typeof import("child_process");
    await send({ type: "filter", filter: ALL });
    const s = await until("six rows", (x) => x.rows.length === 6);
    const c = bySubject(s, "feat: add retry to uploader");
    const repo = s.repos.find((r) => r.id === c.repoId)!;
    const on = { webviewSection: "commit", repoId: c.repoId, sha: c.sha };
    await vscode.commands.executeCommand("polylog.commitCopySha", on);
    assert.strictEqual(await vscode.env.clipboard.readText(), c.sha);
    await vscode.commands.executeCommand("polylog.commitCopyMessage", on);
    const full = cp.execFileSync("git", ["show", "-s", "--format=%B", c.sha], { cwd: repo.root }).toString().trim();
    assert.strictEqual(await vscode.env.clipboard.readText(), full, "the whole message, not only the subject the row shows");

    const git = (...args: string[]) => cp.execFileSync("git", args, { cwd: repo.root }).toString().trim();
    assert.strictEqual(await vscode.commands.executeCommand("polylog.commitOpenOnRemote", on), undefined, "no remote: nothing to open");
    git("remote", "add", "origin", "git@github.com:acme/acme-api.git");
    try {
      assert.strictEqual(await vscode.commands.executeCommand("polylog.commitOpenOnRemote", on), `https://github.com/acme/acme-api/commit/${c.sha}`);
    } finally {
      git("remote", "remove", "origin");
    }
    await vscode.env.clipboard.writeText("unchanged");
    await vscode.commands.executeCommand("polylog.commitCopySha", { ...on, sha: "not-a-sha" });
    await vscode.commands.executeCommand("polylog.commitCopySha", { ...on, sha: UNCOMMITTED });
    assert.strictEqual(await vscode.env.clipboard.readText(), "unchanged", "only a real commit of a listed repository");
  });

  it("the Repositories pane shows how far each repository is from its upstream, following VS Code's Git", async () => {
    const cp = require("child_process") as typeof import("child_process");
    const web = (await snapshot()).repos.find((r) => r.name === "acme-web")!;
    const git = (...args: string[]) => cp.execFileSync("git", args, { cwd: web.root }).toString().trim();
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    // An upstream one commit ahead (made without touching the working tree).
    const theirs = cp.execFileSync("git", ["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "theirs"], {
      cwd: web.root, env: { ...process.env, GIT_AUTHOR_NAME: "rin", GIT_AUTHOR_EMAIL: "rin@example.com", GIT_COMMITTER_NAME: "rin", GIT_COMMITTER_EMAIL: "rin@example.com" },
    }).toString().trim();
    git("update-ref", "refs/heads/polylog-up", theirs);
    git("branch", "--set-upstream-to=polylog-up", branch);
    try {
      // No Refresh: VS Code's Git sees the new upstream and reports it; that repo is read again.
      const s = await until("acme-web behind by one", (x) => x.sync[web.id]?.behind === 1);
      assert.deepStrictEqual(s.sync[web.id], { ahead: 0, behind: 1 });
      assert.ok(Object.keys(s.sync).every((id) => id === web.id), "repositories without an upstream show nothing");
    } finally {
      git("branch", "--unset-upstream", branch);
      git("branch", "-D", "polylog-up");
    }
    await until("no badge once it has no upstream", (x) => x.sync[web.id] === undefined);
    // Refresh reads every repository again too.
    await send({ type: "refresh" });
    await until("still none after Refresh", (x) => x.sync[web.id] === undefined && x.rows.length > 0);
  });

  it("Fetch All fetches every repository, then Show Only Repositories Behind picks the ones to pull", async () => {
    const cp = require("child_process") as typeof import("child_process");
    const fs = require("fs") as typeof import("fs");
    const os = require("os") as typeof import("os");
    const path = require("path") as typeof import("path");
    await send({ type: "filter", filter: ALL });
    const s0 = await until("six rows", (x) => x.rows.length === 6);
    const web = s0.repos.find((r) => r.name === "acme-web")!;
    const api = s0.repos.find((r) => r.name === "acme-api")!;
    const who = { ...process.env, GIT_AUTHOR_NAME: "rin", GIT_AUTHOR_EMAIL: "rin@example.com", GIT_COMMITTER_NAME: "rin", GIT_COMMITTER_EMAIL: "rin@example.com" };
    const git = (cwd: string, ...args: string[]) => cp.execFileSync("git", args, { cwd, env: who }).toString().trim();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-remote-"));
    const branch = git(web.root, "rev-parse", "--abbrev-ref", "HEAD");
    try {
      git(remote, "clone", "-q", "--bare", web.root, "web.git");
      const bare = path.join(remote, "web.git");
      git(web.root, "remote", "add", "origin", bare);
      git(web.root, "fetch", "-q", "origin");
      git(web.root, "branch", `--set-upstream-to=origin/${branch}`, branch);
      // acme-api's remote cannot be reached: its fetch fails, the others still run.
      git(api.root, "remote", "add", "origin", path.join(remote, "missing.git"));
      // Someone pushed a commit: it is on the remote only.
      const theirs = git(bare, "commit-tree", `${branch}^{tree}`, "-p", branch, "-m", "theirs");
      git(bare, "update-ref", `refs/heads/${branch}`, theirs);
      assert.strictEqual((await snapshot()).sync[web.id], undefined, "not known before a fetch: Polylog never fetches on its own");
      const result = await vscode.commands.executeCommand<{ fetched: number; failed: string[] }>("polylog.fetchAll");
      assert.deepStrictEqual(result, { fetched: 2, failed: ["acme-api"] }, "every repository fetched; the unreachable one named");
      const s = await until("acme-web behind by one", (x) => x.sync[web.id]?.behind === 1);
      assert.deepStrictEqual(s.sync[web.id], { ahead: 0, behind: 1 });

      await vscode.commands.executeCommand("polylog.showBehind");
      await until("only the repository behind", (x) => x.filter.repoIds?.join() === web.id && x.rows.every((r) => r.repoId === web.id));
      await vscode.commands.executeCommand("polylog.repoShowAll");
      await until("every repository", (x) => x.filter.repoIds === null && x.rows.length === 6);
    } finally {
      // Each step on its own: one failing must not leave the others' state for later tests.
      const quietly = (f: () => unknown) => { try { f(); } catch { /* not set up */ } };
      quietly(() => git(web.root, "branch", "--unset-upstream", branch));
      quietly(() => git(web.root, "remote", "remove", "origin"));
      quietly(() => git(api.root, "remote", "remove", "origin"));
      fs.rmSync(remote, { recursive: true, force: true });
    }
    await send({ type: "refresh" });
    await until("no badge without the remote", (x) => x.sync[web.id] === undefined && x.rows.length === 6);
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
    await send({ type: "filter", filter: { ...ALL, text: "retry", author: "rin", mine: true, authors: ["noor"] } });
    await until("the filtered log", (x) => x.filter.text === "retry");
    const api = (await snapshot()).repos.find((r) => r.name === "acme-api")!;
    await vscode.commands.executeCommand("polylog.fileHistory", vscode.Uri.file(require("path").join(api.root, "upload.go")));
    let s = await until("upload.go history", (x) => x.history?.path === "upload.go" && x.rows.length === 2);
    assert.deepStrictEqual(s.rows.map((r) => r.subject), ["feat: add retry to uploader (ACME-7)", "feat: scaffold api"], "dana's commit shows too, and so does the one that never says retry");
    assert.deepStrictEqual([s.filter.text, s.filter.author, s.filter.mine, s.filter.authors], ["", "", false, undefined], "the boxes and chips are empty while in the history");
    assert.deepStrictEqual([s.persistedFilter?.text, s.persistedFilter?.author, s.persistedFilter?.mine, s.persistedFilter?.authors], ["retry", "rin", true, ["noor"]], "a reload now would bring the user's filters back");
    await send({ type: "exitHistory" });
    s = await until("all commits again", (x) => x.history === null);
    assert.deepStrictEqual([s.filter.text, s.filter.author, s.filter.mine, s.filter.authors], ["retry", "rin", true, ["noor"]], "closing the history gives the search, author and chips back");
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
    assert.strictEqual((await snapshot()).branches.length, 0, "nothing is read until the Branch box is focused");
    await send({ type: "wantSuggestions", kind: "branches" });
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
