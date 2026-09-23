import type { Commit, FileChange } from "../types";
import { clear, h } from "./dom";
import { absoluteTime, splitPath } from "./view";

export class DetailPane {
  private last: readonly unknown[] = [];

  constructor(private readonly root: HTMLElement, private readonly onOpenFile: (file: FileChange) => void) {}

  /** files: undefined = loading, null = failed (see error). Re-renders only on change, so focus survives. */
  render(commit: Commit | null, repoName: string, files: readonly FileChange[] | null | undefined, error: string | undefined): void {
    const key = [commit, repoName, files, error];
    if (key.length === this.last.length && key.every((v, i) => v === this.last[i])) return;
    this.last = key;
    clear(this.root);
    if (!commit) {
      this.root.append(h("p", { class: "hint" }, ["Select a commit to see its changed files."]));
      return;
    }
    this.root.append(h("div", { class: "detail-header" }, [
      h("div", { class: "detail-subject" }, [commit.subject]),
      h("div", { class: "detail-meta" }, [
        `${repoName} · ${commit.author} · ${absoluteTime(commit.time)} · `,
        h("span", { class: "sha", title: commit.sha }, [commit.sha.slice(0, 7)]),
      ]),
    ]));
    if (error !== undefined) {
      this.root.append(h("p", { class: "error", role: "alert" }, [`Could not read this commit: ${error}`]));
      return;
    }
    if (files === undefined) {
      this.root.append(h("p", { class: "hint" }, ["Loading changed files…"]));
      return;
    }
    if (!files || files.length === 0) {
      this.root.append(h("p", { class: "hint" }, ["This commit changes no files."]));
      return;
    }
    this.root.append(
      h("div", { class: "files-count" }, [`${files.length} ${files.length === 1 ? "file" : "files"} changed`]),
      h("ul", { class: "files" }, files.map((f) => h("li", {}, [this.fileButton(f)]))),
    );
  }

  private fileButton(f: FileChange): HTMLElement {
    const { dir, base } = splitPath(f.path);
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
      h("span", { class: "base" }, [base]),
      dir ? h("span", { class: "dir" }, [dir]) : null,
      h("span", { class: "stat" }, binary
        ? ["binary"]
        : [h("span", { class: "added" }, [`+${f.added}`]), " ", h("span", { class: "deleted" }, [`−${f.deleted}`])]),
    ]);
    button.addEventListener("click", () => this.onOpenFile(f));
    return button;
  }
}
