import * as vscode from "vscode";
import { walkForRepos } from "./discoverWalk";
import { excludeRepos, labelRepos } from "./repos";
import type { Settings } from "./settings";
import type { Repo } from "./types";

// The slice of vscode.git's API that Polylog uses — discovery only. Its
// Repository.log() cannot express --grep, so it is deliberately not used.
interface GitRepository { rootUri: vscode.Uri }
type GitState = "uninitialized" | "initialized";
interface GitAPI {
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
  private started = false;
  /** vscode.git, once it has settled. */
  private ready: GitAPI | undefined;

  async list(settings: Settings): Promise<Repo[]> {
    if (!this.started) {
      this.started = true;
      void this.startGitApi();
    }
    let roots = this.ready ? this.ready.repositories.map((r) => r.rootUri.fsPath) : [];
    if (roots.length === 0) {
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      roots = await walkForRepos(folders, settings.scanDepth);
    }
    return excludeRepos(labelRepos(roots), settings.excludeRepos);
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
    for (const d of this.disposables) d.dispose();
  }
}
