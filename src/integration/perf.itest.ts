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
    console.log("PERF " + JSON.stringify({
      msFirstRows, reposAtFirstRows: first.repos.length, reposSettled: settled.repos.length,
      rowsSettled: settled.rows.length, stats: settled.stats, branches: settled.branches.length,
    }));
  });
});
