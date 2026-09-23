// Runs OUTSIDE VS Code, in plain node. Never import "vscode" here.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import { gitEnv, makeRepo } from "../fixtures";
import { FIXTURE } from "./fixture";

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "..", ".."); // out/integration → repo root
  // Throwaway HOME: no real git config, no real VS Code state.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-itest-home-"));
  const ws = path.join(home, "ws");
  for (const [name, commits] of Object.entries(FIXTURE)) makeRepo(path.join(ws, name), commits, home);
  const workspaceFile = path.join(home, "acme.code-workspace");
  fs.writeFileSync(workspaceFile, JSON.stringify({ folders: Object.keys(FIXTURE).map((n) => ({ path: path.join(ws, n) })) }));
  const env = gitEnv(home);

  await runTests({
    vscodeExecutablePath: await downloadAndUnzipVSCode("stable"),
    extensionDevelopmentPath: repoRoot,
    extensionTestsPath: path.resolve(__dirname, "index.js"),
    launchArgs: [workspaceFile, "--disable-extensions", "--disable-workspace-trust", "--no-sandbox"],
    extensionTestsEnv: {
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_NOSYSTEM: env.GIT_CONFIG_NOSYSTEM,
      GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL,
      POLYLOG_ITEST: "1",
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
