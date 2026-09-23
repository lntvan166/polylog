import type { Commit } from "../types";
import { clear, h } from "./dom";
import { absoluteTime, accentIndex, moveSelection, relativeTime, visibleRange } from "./view";

export interface ListProps {
  rows: readonly Commit[];
  repoNames: ReadonlyMap<string, string>;
  repoIds: readonly string[] | null;
  /** Every repository id in workspace order; each repo's color comes from its place here. */
  repoOrder: readonly string[];
  /** File history: the file's current path, to flag rows where it had another name. */
  historyPath?: string;
  selected: number;
  now: number;
  skeleton: boolean;
}

const SKELETON_ROWS = 8;

/**
 * Virtualized commit grid. Only visible rows exist in the DOM. The grid is one
 * tab stop; the selected row is exposed through aria-activedescendant because
 * recycled rows cannot hold focus themselves.
 */
export class CommitList {
  private rowHeight = 0;
  private props: ListProps = { rows: [], repoNames: new Map(), repoIds: null, repoOrder: [], historyPath: undefined, selected: -1, now: 0, skeleton: false };

  constructor(
    private readonly root: HTMLElement,
    private readonly body: HTMLElement,
    private readonly onSelect: (index: number) => void,
    private readonly onOpen: () => void,
  ) {
    root.addEventListener("scroll", () => this.paint(), { passive: true });
    window.addEventListener("resize", () => {
      this.rowHeight = 0;
      this.paint();
    });
    root.addEventListener("keydown", (e) => this.onKey(e));
    body.addEventListener("click", (e) => {
      const row = (e.target as Element).closest<HTMLElement>(".row[data-index]");
      if (!row) return;
      root.focus();
      this.onSelect(Number(row.dataset.index));
    });
  }

  update(next: ListProps): void {
    const moved = next.selected !== this.props.selected;
    this.props = next;
    if (moved && next.selected >= 0) this.scrollToIndex(next.selected);
    this.paint();
  }

  resetScroll(): void {
    this.root.scrollTop = 0;
  }

  private height(): number {
    if (this.rowHeight === 0) {
      const probe = h("div", { class: "row" }, [h("span", { class: "subject" }, ["M"])]);
      probe.style.visibility = "hidden";
      this.body.append(probe);
      this.rowHeight = probe.offsetHeight || 40;
      probe.remove();
    }
    return this.rowHeight;
  }

  private place(el: HTMLElement, i: number): HTMLElement {
    el.style.transform = `translateY(${i * this.height()}px)`;
    return el;
  }

  private paint(): void {
    const { rows, selected, skeleton } = this.props;
    const rh = this.height();
    clear(this.body);
    this.root.setAttribute("aria-busy", String(skeleton));
    if (skeleton) {
      this.body.style.height = `${SKELETON_ROWS * rh}px`;
      for (let i = 0; i < SKELETON_ROWS; i++) {
        this.body.append(this.place(h("div", { class: "row skeleton", "aria-hidden": "true" }, [
          h("span", { class: "bar short" }), h("span", { class: "bar" }), h("span", { class: "bar short" }), h("span", { class: "bar short" }),
        ]), i));
      }
      this.root.setAttribute("aria-rowcount", "0");
      this.root.removeAttribute("aria-activedescendant");
      return;
    }
    this.body.style.height = `${rows.length * rh}px`;
    this.root.setAttribute("aria-rowcount", String(rows.length));
    const { start, end } = visibleRange(this.root.scrollTop, this.root.clientHeight, rh, rows.length);
    for (let i = start; i < end; i++) this.body.append(this.place(this.renderRow(rows[i], i), i));
    if (selected >= 0 && selected < rows.length) this.root.setAttribute("aria-activedescendant", `row-${selected}`);
    else this.root.removeAttribute("aria-activedescendant");
  }

  /** One line, like an IDE log: repo chip | subject | author | date. */
  private renderRow(c: Commit, i: number): HTMLElement {
    const accent = accentIndex(c.repoId, this.props.repoIds, this.props.repoOrder);
    return h("div", {
      class: "row",
      role: "row",
      id: `row-${i}`,
      "aria-rowindex": String(i + 1),
      "aria-selected": String(i === this.props.selected),
      "data-index": String(i),
    }, [
      h("span", { class: `chip accent-${accent}`, role: "gridcell" }, [this.props.repoNames.get(c.repoId) ?? c.repoId]),
      h("span", { class: "subject", role: "gridcell", title: c.subject }, [
        c.subject,
        // File history: the file had another name in this commit.
        this.props.historyPath && c.file && c.file.path !== this.props.historyPath ? h("span", { class: "was-path" }, [` — ${c.file.path}`]) : null,
      ]),
      h("span", { class: "author", role: "gridcell" }, [c.author]),
      h("span", { class: "date", role: "gridcell", title: absoluteTime(c.time) }, [relativeTime(this.props.now, c.time)]),
    ]);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      this.onOpen();
      return;
    }
    const page = Math.max(1, Math.floor(this.root.clientHeight / this.height()) - 1);
    const next = moveSelection(e.key, this.props.selected, this.props.rows.length, page);
    if (next === null) return;
    e.preventDefault();
    this.onSelect(next);
  }

  private scrollToIndex(i: number): void {
    const rh = this.height();
    const top = i * rh;
    if (top < this.root.scrollTop) this.root.scrollTop = top;
    else if (top + rh > this.root.scrollTop + this.root.clientHeight) this.root.scrollTop = top + rh - this.root.clientHeight;
  }
}
