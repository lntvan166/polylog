import { promises as fs } from "fs";
import * as path from "path";

const SKIP = new Set(["node_modules", ".git"]);

/**
 * Fallback discovery when the Git extension reports nothing: a bounded walk.
 * A `.git` directory or file (worktree, submodule) marks a repository.
 * Symlinked directories are not followed, so a cycle cannot hang the walk.
 */
export async function walkForRepos(roots: readonly string[], depth: number): Promise<string[]> {
  const found: string[] = [];
  async function visit(dir: string, level: number): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.name === ".git")) found.push(dir);
    if (level >= depth) return;
    await Promise.all(entries.filter((e) => e.isDirectory() && !SKIP.has(e.name)).map((e) => visit(path.join(dir, e.name), level + 1)));
  }
  await Promise.all(roots.map((r) => visit(r, 0)));
  return found.sort();
}
