import * as vscode from "vscode";
import { walkForRepos } from "./discoverWalk";
import { excludeRepos, labelRepos, mergeRoots } from "./repos";
import type { Settings } from "./settings";
import type { Repo } from "./types";

// The slice of vscode.git's API that Polylog uses: discovery, and which git binary it found. Its
// Repository.log() cannot express --grep, so it is deliberately not used.
interface GitBranch { name?: string; commit?: string; upstream?: { remote?: string; name?: string }; ahead?: number; behind?: number }
interface GitRepository { rootUri: vscode.Uri; state?: { HEAD?: GitBranch; onDidChange?: vscode.Event<void> } }

/** A repository's state change in vscode.git. */
export interface RepoStateChange {
  root: string;
  /** Its HEAD commit, branch, upstream or ahead/behind differ from the last report (or from when it was first seen). */
  headMoved: boolean;
}

const headKey = (h: GitBranch | undefined) =>
  h ? [h.commit, h.name, h.upstream?.remote, h.upstream?.name, h.ahead, h.behind].map((x) => x ?? "").join("\0") : "";
type GitState = "uninitialized" | "initialized";
interface GitAPI {
  /** The binary vscode.git found (from git.path or its own search). */
  git?: { path?: string };
  state: GitState;
  onDidChangeState: vscode.Event<GitState>;
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
}
interface GitExtension { getAPI(version: 1): GitAPI }

/** vscode.git opens repositories one by one after "initialized"; adopt its list once it has been quiet this long. */
const SETTLE_MS = 1000;

/**
 * Lists the workspace's repositories without ever waiting on vscode.git: the
 * first answer comes from a quick walk of the workspace folders (milliseconds).
 * vscode.git starts in the background; once it has finished opening
 * repositories, its list becomes the source (it honours the user's git
 * settings) and onDidChange fires so the Log can re-check.
 */
export class RepoDiscovery implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [this.emitter];

  /** The git binary VS Code's Git extension uses, once it has activated. */
  gitPath(): string | undefined {
    const p = this.api?.git?.path;
    return typeof p === "string" && p !== "" ? p : undefined;
  }
  private started = false;
  /** vscode.git, once it has settled. */
  private ready: GitAPI | undefined;
  private api: GitAPI | undefined;
  private readonly gitFound = new vscode.EventEmitter<void>();
  /** vscode.git has activated and reported its git binary (see gitPath). */
  readonly onDidFindGit = this.gitFound.event;
  private readonly repoStateChanged = new vscode.EventEmitter<RepoStateChange>();
  /** A repository's state changed in vscode.git (a save, a stage, a checkout): its root. */
  readonly onDidChangeRepoState = this.repoStateChanged.event;

  async list(settings: Settings): Promise<Repo[]> {
    if (!this.started) {
      this.started = true;
      void this.startGitApi();
    }
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const walk = await walkForRepos(folders, settings.scanDepth);
    const git = this.ready ? this.ready.repositories.map((r) => r.rootUri.fsPath) : [];
    return excludeRepos(labelRepos(mergeRoots(walk, git, folders)), settings.excludeRepos);
  }

  private async startGitApi(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!ext) return;
    let api: GitAPI;
    try {
      api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
    } catch {
      return; // git disabled or the extension failed; the walk stays the source
    }
    this.api = api;
    if (this.gitPath()) this.gitFound.fire();
    // One listener per open repository, dropped when vscode.git closes it.
    const watching = new Map<GitRepository, vscode.Disposable>();
    const watch = (r: GitRepository) => {
      const root = r.rootUri.fsPath;
      // Where HEAD stood when first seen, so the first report after a fetch counts as a move.
      let head = headKey(r.state?.HEAD);
      const d = r.state?.onDidChange?.(() => {
        const now = headKey(r.state?.HEAD);
        // Unknown until vscode.git's first status: learning it is not a move.
        const headMoved = head !== "" && now !== head;
        head = now;
        this.repoStateChanged.fire({ root, headMoved });
      });
      if (d) watching.set(r, d);
    };
    const unwatch = (r: GitRepository) => {
      watching.get(r)?.dispose();
      watching.delete(r);
    };
    api.repositories.forEach(watch);
    this.disposables.push(api.onDidOpenRepository(watch), api.onDidCloseRepository(unwatch), {
      dispose: () => {
        for (const d of watching.values()) d.dispose();
        watching.clear();
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settleSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const first = !this.ready;
        this.ready = api;
        if (first || api.repositories.length > 0) this.emitter.fire();
      }, SETTLE_MS);
    };
    this.disposables.push(
      api.onDidOpenRepository(() => (this.ready ? this.emitter.fire() : settleSoon())),
      api.onDidCloseRepository(() => (this.ready ? this.emitter.fire() : settleSoon())),
      api.onDidChangeState((st) => st === "initialized" && settleSoon()),
      { dispose: () => clearTimeout(timer) },
    );
    if (api.state === "initialized") settleSoon();
  }

  dispose(): void {
    this.gitFound.dispose();
    this.repoStateChanged.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
