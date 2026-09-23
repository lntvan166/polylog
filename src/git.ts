import { spawn } from "child_process";

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

/** Async only: the extension host is shared with every other extension. */
export function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...CONFIG, ...args], {
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
      else if (e.code === "ENOENT") reject(new GitError("git was not found on PATH", null));
      else reject(e);
    });
    child.on("close", (code) => {
      if (signal?.aborted) return; // already rejected by the "error" handler
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new GitError(firstLine(Buffer.concat(err).toString("utf8")) || `git exited with code ${code}`, code));
    });
  });
}
