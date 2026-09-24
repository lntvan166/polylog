// TEST-ONLY. Builds throwaway git repositories with a deterministic identity and
// dates so fixtures reproduce on every machine and in CI. Synchronous spawns are
// fine here and nowhere else: this never runs in the extension host.
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface FixtureCommit {
  time: number;
  author: "dana" | "rin";
  message: string;
  /** path → content; null deletes the file. */
  files?: Record<string, string | null>;
}

/** Isolates git from the machine's global and system config (e.g. core.autocrlf on Windows). */
export function gitEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") };
}

export function commitAt(dir: string, home: string, c: FixtureCommit): void {
  for (const [file, content] of Object.entries(c.files ?? {})) {
    const p = path.join(dir, file);
    if (content === null) {
      fs.rmSync(p);
    } else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  }
  const email = `${c.author}@example.com`;
  // `@<unix> +0000` is git's raw commit-date format (unlike --since/--until).
  const date = `@${c.time} +0000`;
  const env = {
    ...gitEnv(home),
    GIT_AUTHOR_NAME: c.author, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: c.author, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: date,
  };
  execFileSync("git", ["add", "-A"], { cwd: dir, env, stdio: "pipe" });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", c.message], { cwd: dir, env, stdio: "pipe" });
}

export function makeRepo(dir: string, commits: FixtureCommit[], home: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env: gitEnv(home), stdio: "pipe" });
  for (const c of commits) commitAt(dir, home, c);
}
