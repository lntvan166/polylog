// All Files in the Changes view: a commit's whole tree, read one folder at a time, merged with
// what the commit changed. Pure: no vscode import.
import type { FileChange } from "./types";

/** One folder's entries at a commit (`git ls-tree` with "dir/" lists its children by full path). */
export function lsTreeArgs(sha: string, dir: string): string[] {
  return ["ls-tree", "-z", sha, "--", dir === "" ? "." : `${dir}/`];
}

/** `git ls-tree -z`: "<mode> <type> <oid>\t<path>". Submodules (commit) are shown as files. */
export function parseLsTree(stdout: string): { path: string; kind: "folder" | "file" }[] {
  const out: { path: string; kind: "folder" | "file" }[] = [];
  for (const t of stdout.split("\0")) {
    const tab = t.indexOf("\t");
    if (tab < 0) continue;
    const type = t.slice(0, tab).split(" ")[1];
    out.push({ path: t.slice(tab + 1), kind: type === "tree" ? "folder" : "file" });
  }
  return out;
}

const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * One folder of All Files: its listing at the commit, with the commit's changes on its files.
 * Files the commit deleted are no longer in the tree; they come back where they were, and so do
 * folders it emptied. Each folder counts the changed files under it.
 */
export function mergeLevel(dir: string, listed: readonly { path: string; kind: "folder" | "file" }[], changed: readonly FileChange[]): {
  folders: { path: string; name: string; changedCount: number }[];
  files: { path: string; name: string; change?: FileChange }[];
} {
  const prefix = dir === "" ? "" : `${dir}/`;
  const changes = new Map(changed.map((f) => [f.path, f]));
  const folders = new Map<string, { path: string; name: string; changedCount: number }>();
  const files = new Map<string, { path: string; name: string; change?: FileChange }>();
  for (const e of listed) {
    if (e.kind === "folder") folders.set(e.path, { path: e.path, name: nameOf(e.path), changedCount: 0 });
    else files.set(e.path, { path: e.path, name: nameOf(e.path), change: changes.get(e.path) });
  }
  for (const f of changed) {
    if (!f.path.startsWith(prefix)) continue;
    const rest = f.path.slice(prefix.length);
    if (!rest.includes("/")) {
      // A file of this folder: deleted ones are not listed at the commit.
      if (!files.has(f.path)) files.set(f.path, { path: f.path, name: rest, change: f });
      continue;
    }
    const sub = `${prefix}${rest.slice(0, rest.indexOf("/"))}`;
    const folder = folders.get(sub) ?? { path: sub, name: nameOf(sub), changedCount: 0 };
    folder.changedCount++;
    folders.set(sub, folder);
  }
  return { folders: [...folders.values()].sort(byName), files: [...files.values()].sort(byName) };
}
