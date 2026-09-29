import * as vscode from "vscode";
import { ChangesTree, type OpenDiffArgs } from "./changesTree";
import { debounce } from "./debounce";
import { GitRunner } from "./git";
import { gitCandidates } from "./gitBinary";
import { UndoCollapse } from "./keepExpanded";
import { HIDE_REPOS_KEY, LogView } from "./logView";
import type { WebviewMessage } from "./protocol";
import { RepoDiscovery } from "./repoDiscovery";
import { RevisionProvider } from "./revisionProvider";
import { SCHEME } from "./revisionUri";

export function activate(context: vscode.ExtensionContext): void {
  const discovery = new RepoDiscovery();
  const changes = new ChangesTree();
  // VS Code's git: git.path first, then the binary its Git extension found, then PATH.
  const git = new GitRunner(() => gitCandidates(vscode.workspace.getConfiguration("git").get("path"), discovery.gitPath()));
  const log = new LogView(context, { discovery, run: git.run, changes });
  // Group by Repository shows the Repositories pane; on unless the user turned it off.
  void vscode.commands.executeCommand("setContext", HIDE_REPOS_KEY, context.globalState.get<boolean>(HIDE_REPOS_KEY, false));
  // Clicking the Log or Changes header collapses that view; expand it again. Settle
  // first: switching to another panel tab hides both, one event at a time.
  const syncUncommittedContext = () =>
    void vscode.commands.executeCommand("setContext", "polylog.showUncommitted", vscode.workspace.getConfiguration("polylog").get<boolean>("showUncommitted", false));
  syncUncommittedContext();
  // Hidden again within 10 s of an undo means the user hid it on purpose (keepExpanded.ts).
  const undo = new UndoCollapse(10_000);
  const undoCollapse = debounce(() => {
    const enabled = vscode.workspace.getConfiguration("polylog").get<boolean>("keepViewsExpanded", true);
    const which = undo.decide(log.visible, changes.visible, Date.now(), enabled, { log: log.canExpand, changes: changes.canExpand });
    if (which === "log") log.expand();
    else if (which === "changes") changes.expand();
  }, 150);
  context.subscriptions.push(
    // Switching git.path takes effect at once: forget the binary, stop git processes still
    // running on the old one, and read everything again.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("git.path")) return;
      git.reset();
      void log.gitChanged();
    }),
    // VS Code's Git extension reports its binary a moment after startup. If no git could
    // run before that, try again with it (otherwise nothing needs reloading).
    discovery.onDidFindGit(() => {
      if (git.failed()) {
        git.reset();
        void log.gitChanged();
      }
    }),
    log.onDidChangeVisibility(undoCollapse),
    changes.onDidChangeVisibility(undoCollapse),
    // Changes can only be revealed once it has a commit: check again when it gets one.
    changes.onDidChangeTreeData(() => undoCollapse()),
    { dispose: () => undoCollapse.cancel() },
    discovery,
    changes,
    vscode.window.registerFileDecorationProvider(changes),
    vscode.commands.registerCommand("polylog.fileHistory", (arg?: unknown) => log.fileHistory(arg)),
    vscode.commands.registerCommand("polylog.openWorkingFile", (arg?: unknown) => log.openWorkingFile(arg)),
    vscode.commands.registerCommand("polylog.showRepos", () => log.setGroupByRepo(true)),
    vscode.commands.registerCommand("polylog.reviewUncommitted", () => log.reviewUncommitted()),
    // The toggle acts at once; the setting is written back in the background.
    vscode.commands.registerCommand("polylog.showUncommitted", () => log.setUncommittedOn(true)),
    vscode.commands.registerCommand("polylog.hideUncommitted", () => log.setUncommittedOn(false)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("polylog.showUncommitted")) void log.uncommittedSettingChanged();
      if (e.affectsConfiguration("polylog.excludeRepos") || e.affectsConfiguration("polylog.scanDepth")) void log.reposSettingChanged();
    }),
    // Uncommitted changes follow the working tree: VS Code's Git reporting a change in a
    // repository, or a save. Only that repository is read again.
    discovery.onDidChangeRepoState((e) => log.repoStateChanged(e.root, e.headMoved)),
    vscode.workspace.onDidSaveTextDocument((doc) => doc.uri.scheme === "file" && log.workingTreeChanged(doc.uri.fsPath)),
    vscode.commands.registerCommand("polylog.hideRepos", () => log.setGroupByRepo(false)),
    // Right-click on a repository in the Log's webview (a Repositories pane row or a commit row).
    vscode.commands.registerCommand("polylog.fetchAll", () => log.fetchAll()),
    vscode.commands.registerCommand("polylog.showBehind", () => log.showBehind()),
    vscode.commands.registerCommand("polylog.repoShowOnly", (arg?: unknown) => log.repoShowOnly(arg)),
    vscode.commands.registerCommand("polylog.repoHide", (arg?: unknown) => log.repoHide(arg)),
    vscode.commands.registerCommand("polylog.repoShowAll", () => log.repoShowAll()),
    vscode.commands.registerCommand("polylog.repoExclude", (arg?: unknown) => log.repoExclude(arg)),
    vscode.commands.registerCommand("polylog.repoOpenFolder", (arg?: unknown) => log.repoOpenFolder(arg)),
    vscode.commands.registerCommand("polylog.repoCopyPath", (arg?: unknown) => log.repoCopyPath(arg)),
    log,
    // Retained: switching the panel to Terminal and back must keep selection and scroll.
    vscode.window.registerWebviewViewProvider(LogView.id, log, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new RevisionProvider(git.run)),
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
