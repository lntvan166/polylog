import * as vscode from "vscode";
import { ChangesStore } from "./changesStore";
import { runGit } from "./git";
import { HIDE_REPOS_KEY, LogView } from "./logView";
import type { OpenDiffArgs, WebviewMessage } from "./protocol";
import { RepoDiscovery } from "./repoDiscovery";
import { RevisionProvider } from "./revisionProvider";
import { SCHEME } from "./revisionUri";

export function activate(context: vscode.ExtensionContext): void {
  const discovery = new RepoDiscovery();
  const changes = new ChangesStore();
  const log = new LogView(context, { discovery, run: runGit, changes });
  // Group by Repository shows the Repositories pane; on unless the user turned it off.
  void vscode.commands.executeCommand("setContext", HIDE_REPOS_KEY, context.globalState.get<boolean>(HIDE_REPOS_KEY, false));
  context.subscriptions.push(
    discovery,
    vscode.commands.registerCommand("polylog.fileHistory", (arg?: unknown) => log.fileHistory(arg)),
    vscode.commands.registerCommand("polylog.openWorkingFile", (arg?: unknown) => log.openWorkingFile(arg)),
    vscode.commands.registerCommand("polylog.showRepos", () => log.setGroupByRepo(true)),
    vscode.commands.registerCommand("polylog.hideRepos", () => log.setGroupByRepo(false)),
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
    );
  }
}

export function deactivate(): void {}
