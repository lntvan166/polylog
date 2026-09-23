import * as assert from "assert";
import * as vscode from "vscode";
import type { PanelSnapshot } from "../logPanel";
import type { WebviewMessage } from "../protocol";
import { EXPECTED_ORDER } from "./fixture";

const snapshot = () => vscode.commands.executeCommand<PanelSnapshot | undefined>("polylog._itest.snapshot");
const send = (m: WebviewMessage) => vscode.commands.executeCommand("polylog._itest.send", m);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, probe: () => PromiseLike<T | undefined> | T | undefined, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const rowsWhen = (what: string, ok: (s: PanelSnapshot) => boolean) =>
  waitFor(what, async () => {
    const s = await snapshot();
    return s && ok(s) ? s : undefined;
  });

async function diffTab(): Promise<vscode.TabInputTextDiff> {
  return waitFor("a diff editor", () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputTextDiff && input.modified.scheme === "polylog" ? input : undefined;
  });
}

describe("Polylog merged log", () => {
  before(async () => {
    await vscode.commands.executeCommand("polylog.open");
    await waitFor("the panel", snapshot);
    await rowsWhen("three repositories", (s) => s.repos.length === 3);
    await send({ type: "filter", filter: { text: "", repoIds: null, date: "all" } });
  });

  it("merges commits from every repository, newest first", async () => {
    const s = await rowsWhen("six rows", (x) => x.rows.length === 6);
    assert.deepStrictEqual(s.rows.map((r) => r.subject), EXPECTED_ORDER);
    assert.strictEqual(new Set(s.rows.map((r) => r.repoId)).size, 3);
    assert.deepStrictEqual(s.failures, []);
  });

  it("narrows by message across repositories", async () => {
    await send({ type: "filter", filter: { text: "acme-7", repoIds: null, date: "all" } });
    const s = await rowsWhen("two ACME-7 rows", (x) => x.rows.length === 2);
    assert.deepStrictEqual(s.rows.map((r) => r.subject), ["docs: link ACME-7 from the changelog", "feat: add retry to uploader (ACME-7)"]);
  });

  it("narrows to a repository subset", async () => {
    const web = (await snapshot())!.repos.find((r) => r.name === "acme-web")!;
    await send({ type: "filter", filter: { text: "", repoIds: [web.id], date: "all" } });
    const s = await rowsWhen("acme-web rows only", (x) => x.rows.length === 2 && x.rows.every((r) => r.repoId === web.id));
    assert.deepStrictEqual(s.rows.map((r) => r.subject), ["fix: guard nil response", "feat: scaffold web"]);
  });

  it("opens a changed file in the native diff editor", async () => {
    await send({ type: "filter", filter: { text: "", repoIds: null, date: "all" } });
    const s = await rowsWhen("six rows again", (x) => x.rows.length === 6);
    const c = s.rows.find((r) => r.subject.startsWith("feat: add retry"))!;
    await send({ type: "openFile", repoId: c.repoId, sha: c.sha, parent: c.parents[0], path: "upload.go" });
    const input = await diffTab();
    assert.strictEqual((await vscode.workspace.openTextDocument(input.original)).getText(), "package upload\n");
    assert.match((await vscode.workspace.openTextDocument(input.modified)).getText(), /func Retry/);
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  it("shows an empty before side for a root commit", async () => {
    const s = (await snapshot())!;
    const c = s.rows.find((r) => r.subject === "feat: scaffold api")!;
    assert.deepStrictEqual(c.parents, []);
    await send({ type: "openFile", repoId: c.repoId, sha: c.sha, parent: null, path: "upload.go" });
    const input = await diffTab();
    assert.strictEqual((await vscode.workspace.openTextDocument(input.original)).getText(), "");
    assert.strictEqual((await vscode.workspace.openTextDocument(input.modified)).getText(), "package upload\n");
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  });

  it("ignores a webview ref that is not a SHA", async () => {
    const s = (await snapshot())!;
    const before = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
    await send({ type: "openFile", repoId: s.rows[0].repoId, sha: "--output=/tmp/polylog-pwned", parent: null, path: "x" });
    await sleep(300);
    assert.strictEqual(vscode.window.tabGroups.all.flatMap((g) => g.tabs).length, before);
  });
});
