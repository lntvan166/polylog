import * as vscode from "vscode";
import { ChangesTree, type OpenDiffArgs } from "./changesTree";
import { runGit } from "./git";
import { LogView } from "./logView";
import type { WebviewMessage } from "./protocol";
import { RepoDiscovery } from "./repoDiscovery";
import { HIDE_REPOS_KEY, ReposTree } from "./reposTree";
import { RevisionProvider } from "./revisionProvider";
import { SCHEME } from "./revisionUri";

export function activate(context: vscode.ExtensionContext): void {
  const discovery = new RepoDiscovery();
  const changes = new ChangesTree();
  const reposTree = new ReposTree();
  const log = new LogView(context, { discovery, run: runGit, changes, reposTree });
  // Group by Repository shows the Repositories pane; on unless the user turned it off.
  const setReposHidden = async (hidden: boolean) => {
    await context.globalState.update(HIDE_REPOS_KEY, hidden);
    await vscode.commands.executeCommand("setContext", HIDE_REPOS_KEY, hidden);
  };
  void setReposHidden(context.globalState.get<boolean>(HIDE_REPOS_KEY, false));
  context.subscriptions.push(
    discovery,
    changes,
    vscode.window.registerFileDecorationProvider(changes),
    reposTree,
    vscode.window.registerFileDecorationProvider(reposTree),
    vscode.commands.registerCommand("polylog.showRepos", () => setReposHidden(false)),
    vscode.commands.registerCommand("polylog.hideRepos", () => setReposHidden(true)),
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
      vscode.commands.registerCommand("polylog._itest.pickRepos", (ids: string[]) => reposTree.pick(ids)),
    );
  }
}

export function deactivate(): void {}
