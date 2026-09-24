import * as nodePath from "path";
import { isSha } from "./types";

// Polylog's own scheme: the git extension's `git:` URIs are internal to
// vscode.git and have changed between releases.
export const SCHEME = "polylog";

export interface RevisionRef {
  root: string;
  /** null renders as empty content (a root commit's "before" side). */
  ref: string | null;
  /** Repository-relative, forward slashes, as git prints it. */
  path: string;
}

export function encodeRevision(r: RevisionRef): { path: string; query: string } {
  return { path: `/${r.path}`, query: JSON.stringify({ root: r.root, ref: r.ref }) };
}

export function decodeRevision(path: string, query: string): RevisionRef {
  let q: { root?: unknown; ref?: unknown };
  try {
    q = JSON.parse(query) as { root?: unknown; ref?: unknown };
  } catch {
    throw new Error("not a polylog revision URI");
  }
  if (typeof q.root !== "string" || !(q.ref === null || isSha(q.ref))) throw new Error("not a polylog revision URI");
  return { root: q.root, ref: q.ref, path: path.replace(/^\//, "") };
}

/**
 * The working-tree file a revision shows ("Open File" on a Polylog diff), or undefined
 * when the repository is not one of the workspace's or the path would leave it.
 */
export function workingFile(r: RevisionRef, repoRoots: readonly string[]): string | undefined {
  if (!repoRoots.includes(r.root) || r.path === "") return undefined;
  const file = nodePath.resolve(r.root, ...r.path.split("/"));
  const rel = nodePath.relative(r.root, file);
  return rel !== "" && !rel.startsWith("..") && !nodePath.isAbsolute(rel) ? file : undefined;
}
