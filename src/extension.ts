import * as vscode from "vscode";
import { ChangesTree, type OpenDiffArgs } from "./changesTree";
import { GitRunner } from "./git";
import { gitCandidates } from "./gitBinary";
import { HIDE_REPOS_KEY, LogView } from "./logView";
import type { WebviewMessage } from "./protocol";
import { RepoDiscovery } from "./repoDiscovery";
import { RevisionProvider } from "./revisionProvider";
import { SCHEME } from "./revisionUri";
import { readSettings } from "./settings";
import { UncommittedStore } from "./uncommittedStore";
import { UncommittedView } from "./uncommittedView";
import { assignAccents } from "./webview/view";

export function activate(context: vscode.ExtensionContext): void {
  const discovery = new RepoDiscovery();
  // All Files reads one folder at a time, through the Log's counted runner (the spawn log sees it).
  const ALL_FILES_KEY = "polylog.changesAllFiles";
  const changes: ChangesTree = new ChangesTree((root, args, signal) => log.countedRun(root, args, signal), context.globalState.get<boolean>(ALL_FILES_KEY, false), () => vscode.workspace.getConfiguration("polylog").get<number>("maxConcurrency", 16));
  const setAllFiles = (on: boolean) => {
    changes.setAllFiles(on);
    void context.globalState.update(ALL_FILES_KEY, on);
    void vscode.commands.executeCommand("setContext", ALL_FILES_KEY, on);
  };
  void vscode.commands.executeCommand("setContext", ALL_FILES_KEY, changes.showsAllFiles);
  // VS Code's git: git.path first, then the binary its Git extension found, then PATH.
  const git = new GitRunner(() => gitCandidates(vscode.workspace.getConfiguration("git").get("path"), discovery.gitPath()));
  // Uncommitted work runs its git through the Log's counted runner (so the spawn log sees it).
  const uncommitted: UncommittedStore = new UncommittedStore({
    run: (cwd, args, signal, opts): Promise<string> => log.countedRun(cwd, args, signal, opts),
    reportsChanges: (root) => discovery.reportsChanges(root),
    canStage: (root) => discovery.vsCodeGitHas(root),
    concurrency: () => readSettings((k) => vscode.workspace.getConfiguration("polylog").get(k)).maxConcurrency,
  });
  const log: LogView = new LogView(context, { discovery, run: git.run, changes, uncommitted });
  const uncommittedView = new UncommittedView({ store: uncommitted, discovery, accents: () => assignAccents(log.repoList), committed: () => log.commitsChanged(), behind: (id) => log.isBehind(id) });
  // Group by Repository shows the Repositories pane; on unless the user turned it off.
  void vscode.commands.executeCommand("setContext", HIDE_REPOS_KEY, context.globalState.get<boolean>(HIDE_REPOS_KEY, false));
  // Polylog never opens, expands or reveals a view by itself: hiding and collapsing are the user's.
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
    discovery,
    changes,
    vscode.window.registerFileDecorationProvider(changes),
    vscode.commands.registerCommand("polylog.fileHistory", (arg?: unknown) => log.fileHistory(arg)),
    vscode.commands.registerCommand("polylog.openWorkingFile", (arg?: unknown) => log.openWorkingFile(arg)),
    vscode.commands.registerCommand("polylog.showRepos", () => log.setGroupByRepo(true)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("polylog.excludeRepos") || e.affectsConfiguration("polylog.scanDepth")) void log.reposSettingChanged();
    }),
    // Uncommitted changes follow the working tree: VS Code's Git reporting a change in a
    // repository, or a save. Only that repository is read again.
    discovery.onDidChangeRepoState((e) => log.repoStateChanged(e.root, e.headMoved, e.initial)),
    discovery.onDidChangeWatched(() => uncommittedView.refresh()),
    log.onDidChangeSync(() => uncommittedView.refresh()),
    vscode.workspace.onDidSaveTextDocument((doc) => doc.uri.scheme === "file" && uncommitted.touch(doc.uri.fsPath)),
    uncommitted,
    uncommittedView,
    vscode.window.registerFileDecorationProvider(uncommittedView),
    vscode.commands.registerCommand("polylog.focusUncommitted", () => vscode.commands.executeCommand("polylog.uncommitted.focus")),
    vscode.commands.registerCommand("polylog.refreshUncommitted", () => uncommitted.readAll(true)),
    vscode.commands.registerCommand("polylog.stage", (arg?: unknown) => uncommittedView.stage(arg)),
    vscode.commands.registerCommand("polylog.unstage", (arg?: unknown) => uncommittedView.unstage(arg)),
    vscode.commands.registerCommand("polylog.discard", (arg?: unknown) => uncommittedView.discard(arg)),
    vscode.commands.registerCommand("polylog.commitRepo", (arg?: unknown) => uncommittedView.commit(arg)),
    vscode.commands.registerCommand("polylog.openUncommittedDiff", (arg?: unknown) => uncommittedView.openDiff(arg)),
    vscode.commands.registerCommand("polylog.hideRepos", () => log.setGroupByRepo(false)),
    // Right-click on a repository in the Log's webview (a Repositories pane row or a commit row).
    vscode.commands.registerCommand("polylog.fetchAll", () => log.fetchAll()),
    // Right-click a commit row in the Log.
    vscode.commands.registerCommand("polylog.commitCopySha", (arg?: unknown) => log.commitCopySha(arg)),
    vscode.commands.registerCommand("polylog.commitCopyMessage", (arg?: unknown) => log.commitCopyMessage(arg)),
    vscode.commands.registerCommand("polylog.commitOpenOnRemote", (arg?: unknown) => log.commitOpenOnRemote(arg)),
    vscode.commands.registerCommand("polylog.showBehind", () => log.showBehind()),
    vscode.commands.registerCommand("polylog.repoPull", (arg?: unknown) => log.repoPull(arg)),
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
    vscode.commands.registerCommand("polylog.openRevision", (arg?: unknown) => log.openRevision(arg)),
    vscode.commands.registerCommand("polylog.changesShowAll", () => setAllFiles(true)),
    vscode.commands.registerCommand("polylog.changesShowChanged", () => setAllFiles(false)),
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
      vscode.commands.registerCommand("polylog._itest.uncommitted", () => uncommittedView.snapshot()),
      vscode.commands.registerCommand("polylog._itest.expandChanges", (dir: string) => changes.expandPath(dir)),
      vscode.commands.registerCommand("polylog._itest.answer", (v: string | undefined) => uncommittedView.ask.queue(v)),
    );
  }
}

export function deactivate(): void {}
