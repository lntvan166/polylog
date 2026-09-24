import { spawn } from "child_process";
import { promises as fs } from "fs";

export class GitError extends Error {
  constructor(message: string, readonly exitCode: number | null) {
    super(message);
    this.name = "GitError";
  }
}

// Overrides that keep output parseable whatever the user's git config says.
const CONFIG = [
  "-c", "log.showSignature=false",
  "-c", "core.quotepath=off",
  "-c", "i18n.logOutputEncoding=UTF-8",
  "-c", "color.ui=never",
];

function firstLine(stderr: string): string {
  const line = stderr.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.replace(/^(fatal|error): /, "").trim();
}

/** Spawn failures that mean "this binary cannot run here", so the next candidate is tried. */
// EINVAL: Node refuses to spawn a Windows .cmd/.bat without a shell.
const NOT_RUNNABLE = new Set(["ENOENT", "EACCES", "ENOTDIR", "EISDIR", "EINVAL", "EPERM"]);

class NotRunnable extends Error {}

function spawnGit(binary: string, cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...CONFIG, ...args], {
      cwd,
      signal,
      windowsHide: true,
      // No credential prompts; no index.lock contention with VS Code's own git.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.name === "AbortError") reject(e);
      else if (e.code && NOT_RUNNABLE.has(e.code)) reject(new NotRunnable(e.code));
      else reject(e);
    });
    child.on("close", (code) => {
      if (signal?.aborted) return; // already rejected by the "error" handler
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new GitError(firstLine(Buffer.concat(err).toString("utf8")) || `git exited with code ${code}`, code));
    });
  });
}

/**
 * Runs git with the first binary that can run: VS Code's `git.path`, then the path VS
 * Code's Git extension found, then git on PATH (gitBinary.ts). The working binary is
 * remembered until reset(), which the extension calls when `git.path` changes.
 * Async only: the extension host is shared with every other extension.
 */
export class GitRunner {
  private resolved: string | undefined;
  /** Bumped by reset(): a lookup that started before git.path changed must not win. */
  private generation = 0;
  private lastFailed = false;

  constructor(private readonly candidates: () => string[]) {}

  /** No candidate could run on the last attempt (VS Code's Git reporting its path may help). */
  failed(): boolean {
    return this.lastFailed;
  }

  /** The binary in use, once one has run. */
  binary(): string | undefined {
    return this.resolved;
  }

  reset(): void {
    this.resolved = undefined;
    this.generation++;
  }

  readonly run = async (cwd: string, args: string[], signal?: AbortSignal): Promise<string> => {
    const generation = this.generation;
    if (this.resolved) {
      try {
        return await spawnGit(this.resolved, cwd, args, signal);
      } catch (e) {
        if (!(e instanceof NotRunnable)) throw e;
        await this.checkFolder(cwd);
        this.resolved = undefined; // it ran before and stopped: look again
      }
    }
    const tried: string[] = [];
    for (const binary of this.candidates()) {
      try {
        const out = await spawnGit(binary, cwd, args, signal);
        this.remember(binary, generation);
        return out;
      } catch (e) {
        if (!(e instanceof NotRunnable)) {
          this.remember(binary, generation); // it ran; the error is git's own
          throw e;
        }
        // A missing working folder looks exactly like a missing binary (both ENOENT).
        await this.checkFolder(cwd);
        tried.push(binary);
      }
    }
    if (generation === this.generation) this.lastFailed = true;
    throw new GitError(`git was not found (tried: ${tried.join(", ")}). Check the git.path setting.`, null);
  };

  private remember(binary: string, generation: number): void {
    if (generation !== this.generation) return; // git.path changed meanwhile
    this.resolved = binary;
    this.lastFailed = false;
  }

  private async checkFolder(cwd: string): Promise<void> {
    const ok = await fs.stat(cwd).then((s) => s.isDirectory(), () => false);
    if (!ok) throw new GitError(`the repository folder is missing: ${cwd}`, null);
  }
}

/** git from PATH only: tests and callers with no VS Code settings. */
export const runGit = new GitRunner(() => ["git"]).run;
