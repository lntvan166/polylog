import type { RevisionRef } from "./revisionUri";
import type { Commit, FileChange } from "./types";

export function showArgs(sha: string): string[] {
  // -z: paths unquoted and NUL-terminated; -M: renames even if diff.renames=false;
  // merges diff against their first parent, matching the diff editor's "before".
  return ["show", "--numstat", "-z", "-M", "--diff-merges=first-parent", "--format=", sha];
}

const STAT = /^\n*(-|\d+)\t(-|\d+)\t([\s\S]*)$/;

export function parseNumstat(stdout: string): FileChange[] {
  const tokens = stdout.split("\0");
  const files: FileChange[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = STAT.exec(tokens[i]);
    if (!m) continue;
    const added = m[1] === "-" ? null : Number(m[1]);
    const deleted = m[2] === "-" ? null : Number(m[2]);
    if (m[3] !== "") {
      files.push({ path: m[3], added, deleted });
      continue;
    }
    // Rename: "<a>\t<d>\t\0<old>\0<new>\0"
    const oldPath = tokens[i + 1];
    const path = tokens[i + 2];
    i += 2;
    if (!oldPath || !path) break;
    files.push({ path, oldPath, added, deleted });
  }
  return files;
}

export function diffSides(
  root: string,
  commit: Pick<Commit, "sha" | "parents">,
  file: Pick<FileChange, "path" | "oldPath">,
): { before: RevisionRef; after: RevisionRef } {
  return {
    before: { root, ref: commit.parents[0] ?? null, path: file.oldPath ?? file.path },
    after: { root, ref: commit.sha, path: file.path },
  };
}
