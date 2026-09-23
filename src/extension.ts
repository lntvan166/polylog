import * as vscode from "vscode";
import { runGit } from "./git";
import { LogPanel } from "./logPanel";
import type { WebviewMessage } from "./protocol";
import { RepoDiscovery } from "./repoDiscovery";
import { RevisionProvider } from "./revisionProvider";
import { SCHEME } from "./revisionUri";

export function activate(context: vscode.ExtensionContext): void {
  const discovery = new RepoDiscovery();
  const deps = { discovery, run: runGit };
  context.subscriptions.push(
    discovery,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionProvider(runGit)),
    vscode.commands.registerCommand("polylog.open", () => {
      LogPanel.show(context, deps);
    }),
    { dispose: () => LogPanel.current?.dispose() },
  );
  // Test seam for the integration suite only; never registered for users.
  if (process.env.POLYLOG_ITEST === "1") {
    context.subscriptions.push(
      vscode.commands.registerCommand("polylog._itest.snapshot", () => LogPanel.current?.snapshot()),
      vscode.commands.registerCommand("polylog._itest.send", (m: WebviewMessage) => LogPanel.current?.onMessage(m)),
    );
  }
}

export function deactivate(): void {}
