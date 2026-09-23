import type { Commit, FileChange } from "../types";
import { clear, h } from "./dom";
import { absoluteTime, fileTree, type TreeFolder, type TreeNode } from "./view";

/** Changed files as a folder tree on top, the full commit message below. */
export class DetailPane {
  private last: readonly unknown[] = [];

  constructor(private readonly root: HTMLElement, private readonly onOpenFile: (file: FileChange) => void) {}

  /** files: undefined = loading, null = failed (see error). Re-renders only on change, so focus survives. */
  render(
    commit: Commit | null,
    repoName: string,
    files: readonly FileChange[] | null | undefined,
    error: string | undefined,
    message: string | undefined,
  ): void {
    const key = [commit, repoName, files, error, message];
    if (key.length === this.last.length && key.every((v, i) => v === this.last[i])) return;
    this.last = key;
    clear(this.root);
    if (!commit) {
      this.root.append(h("p", { class: "hint" }, ["Select a commit to see its changed files."]));
      return;
    }
    const top = h("div", { class: "detail-files" });
    if (error !== undefined) {
      top.append(h("p", { class: "error", role: "alert" }, [`Could not read this commit: ${error}`]));
    } else if (files === undefined) {
      top.append(h("p", { class: "hint" }, ["Loading changed files…"]));
    } else if (!files || files.length === 0) {
      top.append(h("p", { class: "hint" }, ["This commit changes no files."]));
    } else {
      top.append(
        h("div", { class: "files-count" }, [`${files.length} ${files.length === 1 ? "file" : "files"} changed · ${repoName}`]),
        this.nodes(fileTree(files)),
      );
    }
    this.root.append(top, h("div", { class: "detail-message", role: "region", "aria-label": "Commit message" }, [
      h("div", { class: "message-text" }, [message ?? commit.subject]),
      h("div", { class: "message-meta" }, [
        h("span", { class: "sha", title: commit.sha }, [commit.sha.slice(0, 7)]),
        ` ${commit.author} <${commit.email}> · ${absoluteTime(commit.time)}`,
      ]),
    ]));
  }

  private nodes(nodes: readonly TreeNode[]): HTMLElement {
    return h("ul", { class: "tree" }, nodes.map((n) => h("li", {}, [n.kind === "folder" ? this.folder(n) : this.fileButton(n.file, n.name)])));
  }

  private folder(n: TreeFolder): HTMLElement {
    return h("details", { class: "folder", open: true }, [
      h("summary", {}, [h("span", { class: "folder-name" }, [n.name]), h("span", { class: "folder-count" }, [String(n.count)])]),
      this.nodes(n.children),
    ]);
  }

  private fileButton(f: FileChange, name: string): HTMLElement {
    const binary = f.added === null;
    const label = binary
      ? `${f.path}, binary file`
      : `${f.path}, ${f.added} added, ${f.deleted} deleted${f.oldPath ? `, renamed from ${f.oldPath}` : ""}`;
    const button = h("button", {
      class: "file",
      type: "button",
      "aria-label": label,
      title: binary ? "Binary file: no text diff" : f.oldPath ? `${f.oldPath} → ${f.path}` : f.path,
      disabled: binary,
    }, [
      h("span", { class: "base" }, [name]),
      f.oldPath ? h("span", { class: "dir" }, [`← ${f.oldPath}`]) : null,
      h("span", { class: "stat" }, binary
        ? ["binary"]
        : [h("span", { class: "added" }, [`+${f.added}`]), " ", h("span", { class: "deleted" }, [`−${f.deleted}`])]),
    ]);
    button.addEventListener("click", () => this.onOpenFile(f));
    return button;
  }
}
