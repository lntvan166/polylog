import type { FileChange } from "./types";

export interface TreeFolder {
  kind: "folder";
  /** One or more path segments: single-child folder chains are shown as "a/b". */
  name: string;
  count: number;
  children: TreeNode[];
}
export interface TreeFile {
  kind: "file";
  name: string;
  file: FileChange;
}
export type TreeNode = TreeFolder | TreeFile;

/** Changed files as a folder tree: folders first, then files, each alphabetical. */
export function fileTree(files: readonly FileChange[]): TreeNode[] {
  const root: TreeFolder = { kind: "folder", name: "", count: 0, children: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.children.find((c): c is TreeFolder => c.kind === "folder" && c.name === part);
      if (!next) {
        next = { kind: "folder", name: part, count: 0, children: [] };
        dir.children.push(next);
      }
      dir = next;
    }
    dir.children.push({ kind: "file", name: parts[parts.length - 1], file });
  }
  const finish = (node: TreeFolder): TreeFolder => {
    node.children = node.children.map((c) => (c.kind === "folder" ? finish(c) : c));
    node.count = node.children.reduce((n, c) => n + (c.kind === "folder" ? c.count : 1), 0);
    while (node.name !== "" && node.children.length === 1 && node.children[0].kind === "folder") {
      const only: TreeFolder = node.children[0];
      node.name = `${node.name}/${only.name}`;
      node.children = only.children;
    }
    node.children.sort((a, b) => (a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return node;
  };
  return finish(root).children;
}
