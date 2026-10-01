// Startup measurement for dev/perf/run.mjs (not part of the regular suite).
import * as vscode from "vscode";
import type { LogSnapshot } from "../logView";

const snapshot = () => vscode.commands.executeCommand<LogSnapshot | undefined>("polylog._itest.snapshot");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Polylog startup", () => {
  it("measures time to first rows and the load work done", async function () {
    this.timeout(180000);
    const t0 = Date.now();
    await vscode.commands.executeCommand("polylog.open");
    let first: LogSnapshot | undefined;
    for (;;) {
      const s = await snapshot();
      if (s && s.rows.length > 0) {
        first = s;
        break;
      }
      if (Date.now() - t0 > 120000) throw new Error("no rows after 120s");
      await sleep(20);
    }
    const msFirstRows = Date.now() - t0;
    await sleep(10000); // let repository discovery and background reads settle
    const settled = (await snapshot())!;
    // Show Uncommitted Changes, with 5 of the repositories dirty.
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const dirty = settled.repos.slice(0, 5);
    for (const r of dirty) fs.writeFileSync(path.join(r.root, "UNCOMMITTED.md"), "x\n");
    // Uncommitted work is read in the background; Refresh reads every repository again.
    const known = (s: LogSnapshot | undefined) => (s ? s.uncommitted.filter((w) => w.changes.length + w.staged.length > 0).length : 0);
    const t1 = Date.now();
    void vscode.commands.executeCommand("polylog._itest.send", { type: "refresh" });
    let msFirstPinned = -1;
    for (;;) {
      const n = known(await snapshot());
      if (n > 0 && msFirstPinned < 0) msFirstPinned = Date.now() - t1;
      if (n === dirty.length) break;
      if (Date.now() - t1 > 60000) throw new Error("the uncommitted work never all appeared");
      await sleep(5);
    }
    const msAllPinned = Date.now() - t1;
    // One editor save in one dirty repository, with the rows shown: what does it cost?
    await sleep(2000);
    const before = (await snapshot())!;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(dirty[0].root, "UNCOMMITTED.md")));
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(0, 0), "more\n");
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    await sleep(2500); // the save, then VS Code's Git reporting the same repository
    const after = (await snapshot())!;
    const posted = (s: LogSnapshot) => Object.values(s.posts).reduce((n, p) => n + p.bytes, 0);
    const save = {
      spawns: after.spawnLog.length - before.spawnLog.length,
      reposRead: new Set(after.spawnLog.slice(before.spawnLog.length).map((x) => x.root)).size,
      postBytes: posted(after) - posted(before),
    };
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    for (const r of dirty) fs.rmSync(path.join(r.root, "UNCOMMITTED.md"));
    console.log("PERF " + JSON.stringify({
      msFirstRows, reposAtFirstRows: first.repos.length, reposSettled: settled.repos.length,
      rowsSettled: settled.rows.length, stats: settled.stats, branches: settled.branches.length,
      uncommitted: { msFirstPinned, msAllPinned, dirty: dirty.length, save },
    }));
  });
});
