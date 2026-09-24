import type { NodeDesc } from "../changesModel";
import type { ChangesView } from "../protocol";
import { clear, h } from "./dom";
import { contextFor, flatten, treeKey, type TreeRow } from "./changesPaneModel";

// Inline SVG, not a codicon: the codicon font would be a bundled webfont.
const CHEVRON = () => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("chevron");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M6 4l4 4-4 4");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "1.3");
  svg.append(p);
  return svg;
};

/**
 * The Changes pane (panel spec §15): the selected commit's header and its file tree,
 * drawn in the Log webview so the panel tab has one view and no collapsible headers.
 * The tree is one tab stop; the active row is exposed through aria-activedescendant.
 */
export class ChangesPane {
  private view: ChangesView = { message: undefined, roots: [], focusPath: undefined, body: "" };
  private rows: TreeRow[] = [];
  private folded = new Set<string>();
  private active = -1;
  private commitId: string | undefined;

  constructor(
    private readonly head: HTMLElement,
    private readonly status: HTMLElement,
    private readonly tree: HTMLElement,
    private readonly onOpen: (path: string) => void,
  ) {
    tree.addEventListener("keydown", (e) => this.onKey(e));
    tree.addEventListener("focus", () => {
      if (this.active < 0 && this.rows.length > 0) this.setActive(0);
    });
    tree.addEventListener("click", (e) => {
      const el = (e.target as Element).closest<HTMLElement>(".tree-row[data-index]");
      if (!el) return;
      const i = Number(el.dataset.index);
      this.setActive(i);
      const row = this.rows[i];
      if (row.node.kind === "file") {
        if (row.node.openable) this.onOpen(row.node.path);
      } else {
        this.toggle(row.node.id);
      }
    });
    // Right-click selects the row first, as VS Code's own trees do.
    tree.addEventListener("contextmenu", (e) => {
      const el = (e.target as Element).closest<HTMLElement>(".tree-row[data-index]");
      if (el) this.setActive(Number(el.dataset.index));
    });
  }

  update(view: ChangesView): void {
    const commit = view.roots[0];
    if (commit?.id !== this.commitId) {
      this.commitId = commit?.id;
      this.active = -1;
      this.tree.scrollTop = 0;
    }
    this.view = view;
    this.rows = flatten(commit && commit.kind === "commit" ? commit.children : [], this.folded);
    // File history: select the history's file so the eye lands on it.
    if (view.focusPath) {
      const i = this.rows.findIndex((r) => r.node.kind === "file" && r.node.path === view.focusPath);
      if (i >= 0) this.active = i;
    }
    if (this.active >= this.rows.length) this.active = this.rows.length - 1;
    this.paint();
    if (view.focusPath && this.active >= 0) this.reveal(this.active);
  }

  private paint(): void {
    const commit = this.view.roots[0];
    clear(this.head);
    this.head.hidden = !commit;
    if (commit) {
      this.head.setAttribute("data-vscode-context", contextFor(commit));
      this.head.title = commit.tooltip;
      this.head.append(h("div", { class: "commit-subject" }, [commit.label]), h("div", { class: "commit-meta" }, [commit.description]));
      if (this.view.body) this.head.append(h("div", { class: "commit-body" }, [this.view.body]));
    }
    this.status.textContent = this.view.message ?? "";
    this.status.hidden = !this.view.message;
    clear(this.tree);
    this.tree.hidden = this.rows.length === 0;
    this.rows.forEach((row, i) => this.tree.append(this.renderRow(row, i)));
    if (this.active >= 0) this.tree.setAttribute("aria-activedescendant", `tree-row-${this.active}`);
    else this.tree.removeAttribute("aria-activedescendant");
  }

  private renderRow(row: TreeRow, i: number): HTMLElement {
    const n: NodeDesc = row.node;
    const status = n.kind === "file" ? n.file.status : undefined;
    const el = h("div", {
      class: `tree-row${status ? ` status-${status}` : ""}${n.kind === "file" && !n.openable ? " binary" : ""}`,
      role: "treeitem",
      id: `tree-row-${i}`,
      "aria-level": String(row.depth + 1),
      "aria-expanded": row.expanded === undefined ? undefined : String(row.expanded),
      "aria-selected": String(i === this.active),
      "data-index": String(i),
      "data-vscode-context": contextFor(n),
      title: n.tooltip,
    }, [
      row.expanded === undefined ? h("span", { class: "twistie" }) : h("span", { class: `twistie${row.expanded ? " open" : ""}` }, [CHEVRON()]),
      h("span", { class: "tree-name" }, [n.label]),
      h("span", { class: "tree-desc" }, [n.description]),
      status ? h("span", { class: "tree-badge", "aria-label": n.tooltip }, [status]) : null,
    ]);
    // Indent by depth. A style property, not a style attribute: the CSP forbids those.
    el.style.paddingLeft = `${4 + row.depth * 12}px`;
    return el;
  }

  /**
   * Selection changes only restyle the rows. Rebuilding them here would replace the row
   * under the pointer between mousedown and mouseup (focus lands in between), and the
   * click would then never reach it.
   */
  private setActive(i: number): void {
    this.active = i;
    for (const el of this.tree.querySelectorAll<HTMLElement>(".tree-row[data-index]")) {
      el.setAttribute("aria-selected", String(Number(el.dataset.index) === i));
    }
    if (i >= 0) this.tree.setAttribute("aria-activedescendant", `tree-row-${i}`);
    else this.tree.removeAttribute("aria-activedescendant");
    this.reveal(i);
  }

  private toggle(id: string): void {
    if (this.folded.has(id)) this.folded.delete(id);
    else this.folded.add(id);
    this.update(this.view);
  }

  private reveal(i: number): void {
    this.tree.querySelector<HTMLElement>(`#tree-row-${i}`)?.scrollIntoView({ block: "nearest" });
  }

  private onKey(e: KeyboardEvent): void {
    const move = treeKey(e.key, this.rows, this.active);
    if (!move) return;
    e.preventDefault();
    if ("active" in move) this.setActive(move.active);
    else if ("open" in move) this.onOpen(move.open);
    else if ("fold" in move) this.toggle(move.fold);
    else this.toggle(move.unfold);
  }
}
