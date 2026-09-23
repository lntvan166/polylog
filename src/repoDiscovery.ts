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

const INIT_TIMEOUT_MS = 5000;

export class RepoDiscovery implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [this.emitter];
  private api: Promise<GitAPI | undefined> | undefined;

  async list(settings: Settings): Promise<Repo[]> {
    const api = await (this.api ??= this.loadGitApi());
    let roots = api ? api.repositories.map((r) => r.rootUri.fsPath) : [];
    if (roots.length === 0) {
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
      roots = await walkForRepos(folders, settings.scanDepth);
    }
    return excludeRepos(labelRepos(roots), settings.excludeRepos);
  }

  private async loadGitApi(): Promise<GitAPI | undefined> {
    const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!ext) return undefined;
    try {
      const api = (ext.isActive ? ext.exports : await ext.activate()).getAPI(1);
      if (api.state !== "initialized") {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, INIT_TIMEOUT_MS);
          const sub = api.onDidChangeState((s) => s === "initialized" && done());
          function done() {
            clearTimeout(timer);
            sub.dispose();
            resolve();
          }
        });
      }
      this.disposables.push(api.onDidOpenRepository(() => this.emitter.fire()), api.onDidCloseRepository(() => this.emitter.fire()));
      return api;
    } catch {
      return undefined; // git disabled or the extension failed; the walk takes over
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
