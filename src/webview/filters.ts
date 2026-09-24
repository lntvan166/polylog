import { DEFAULT_FILTER, isValidRef, type DatePreset, type FilterState } from "../filterModel";
import type { AuthorName, BranchName } from "../protocol";
import { byId, clear, h } from "./dom";

/**
 * The filter bar. It only reports intent: every change goes to the host, which
 * turns it into git flags. (Repositories are picked in the RepoPane.)
 */
export class FilterBar {
  private filter: FilterState | undefined;
  private readonly search = byId<HTMLInputElement>("search");
  private readonly author = byId<HTMLInputElement>("author");
  private readonly authorChips = byId("author-chips");
  private readonly authorList = byId("author-list");
  private readonly meButton = byId<HTMLButtonElement>("me");
  private readonly branch = byId<HTMLInputElement>("branch");
  private readonly branchList = byId("branch-list");
  private readonly date = byId<HTMLSelectElement>("date");
  private readonly customRange = byId("custom-range");
  private readonly from = byId<HTMLInputElement>("from");
  private readonly to = byId<HTMLInputElement>("to");

  constructor(private readonly onChange: (f: FilterState) => void, onRefresh: () => void) {
    byId("filters").addEventListener("submit", (e) => e.preventDefault());
    this.search.addEventListener("input", () => this.emit({ text: this.search.value }));
    // Typing filters as you go (debounced by the host). Enter, a comma or a picked
    // suggestion turns it into a chip, and the next author can be typed.
    this.author.addEventListener("input", (e) => {
      const v = this.author.value;
      if ((e as InputEvent).inputType === "insertReplacementText" || v.endsWith(",")) this.addAuthor(v.replace(/,$/, ""));
      else this.emit({ author: v });
    });
    this.author.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.author.value.trim()) {
        e.preventDefault();
        this.addAuthor(this.author.value);
      } else if (e.key === "Backspace" && this.author.value === "" && (this.current().authors ?? []).length > 0) {
        e.preventDefault();
        this.removeAuthor((this.current().authors ?? []).length - 1);
      }
    });
    this.authorChips.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLElement>("[data-chip]");
      if (b) this.removeAuthor(Number(b.dataset.chip));
    });
    this.meButton.addEventListener("click", () => this.emit({ mine: !this.current().mine }));
    // A branch applies when committed (Enter, a picked suggestion, leaving the box), not per keystroke.
    this.branch.addEventListener("change", () => this.applyBranch());
    this.branch.addEventListener("input", () => {
      if (this.branch.value === "") this.applyBranch(); // the search box's clear button
      else this.branch.removeAttribute("aria-invalid");
    });
    this.date.addEventListener("change", () => {
      const date = this.date.value as DatePreset;
      const { text, author, mine, authors, branch, repoIds } = this.current();
      this.onChange(date === "custom"
        ? { text, author, mine, authors, branch, repoIds, date, from: this.from.value || undefined, to: this.to.value || undefined }
        : { text, author, mine, authors, branch, repoIds, date });
    });
    for (const input of [this.from, this.to]) {
      input.addEventListener("change", () => this.emit({ from: this.from.value || undefined, to: this.to.value || undefined }));
    }
    byId("refresh").addEventListener("click", onRefresh);
  }

  update(filter: FilterState): void {
    this.filter = filter;
    if (this.search.value !== filter.text) this.search.value = filter.text;
    if (this.author.value !== filter.author) this.author.value = filter.author;
    const chips = filter.authors ?? [];
    this.author.placeholder = chips.length > 0 || filter.mine ? "Add author" : "Author";
    this.renderChips(chips);
    this.meButton.setAttribute("aria-pressed", String(filter.mine));
    if (document.activeElement !== this.branch && this.branch.value !== filter.branch) this.branch.value = filter.branch;
    this.date.value = filter.date;
    this.customRange.hidden = filter.date !== "custom";
    this.from.value = filter.from ?? "";
    this.to.value = filter.to ?? "";
  }

  private applyBranch(): void {
    const b = this.branch.value.trim();
    if (b && !isValidRef(b)) {
      this.branch.setAttribute("aria-invalid", "true");
      return;
    }
    this.branch.removeAttribute("aria-invalid");
    if (b !== this.current().branch) this.emit({ branch: b });
  }

  /** Suggestions for the Branch box: names shared by the most repositories first. */
  setBranches(items: readonly BranchName[]): void {
    clear(this.branchList);
    for (const b of items) this.branchList.append(h("option", { value: b.name, label: `${b.count} ${b.count === 1 ? "repo" : "repos"}` }));
  }

  /** Suggestions for the Author box: people who committed recently, most commits first. */
  setAuthors(items: readonly AuthorName[]): void {
    clear(this.authorList);
    for (const a of items) this.authorList.append(h("option", { value: a.name, label: `${a.email} · ${a.count}` }));
  }

  private addAuthor(raw: string): void {
    const name = raw.trim();
    const chips = this.current().authors ?? [];
    if (!name) return;
    const next = chips.some((c) => c.toLowerCase() === name.toLowerCase()) ? chips : [...chips, name];
    this.author.value = "";
    this.emit({ authors: next, author: "" });
  }

  private removeAuthor(i: number): void {
    const next = (this.current().authors ?? []).filter((_, k) => k !== i);
    this.emit({ authors: next.length > 0 ? next : undefined });
    this.author.focus();
  }

  private renderChips(chips: readonly string[]): void {
    if (this.authorChips.childElementCount === chips.length && [...this.authorChips.children].every((c, i) => (c as HTMLElement).dataset.name === chips[i])) return;
    clear(this.authorChips);
    chips.forEach((name, i) => {
      this.authorChips.append(h("span", { class: "author-chip", role: "listitem", "data-name": name, title: name }, [
        h("span", { class: "author-chip-name" }, [name]),
        h("button", { class: "author-chip-remove", type: "button", "data-chip": String(i), "aria-label": `Remove author ${name}`, title: `Remove ${name}` }, ["×"]),
      ]));
    });
  }

  /** Shown once the host knows at least one repository's user.email. */
  setMe(hasMe: boolean): void {
    this.meButton.hidden = !hasMe;
    this.meButton.title = "Only my commits (each repository's user.email)";
  }

  private current(): FilterState {
    return this.filter ?? DEFAULT_FILTER;
  }

  private emit(patch: Partial<FilterState>): void {
    this.onChange({ ...this.current(), ...patch });
  }
}
