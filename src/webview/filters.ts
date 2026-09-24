import { DEFAULT_FILTER, isValidRef, type DatePreset, type FilterState } from "../filterModel";
import type { BranchName } from "../protocol";
import { byId, clear, h } from "./dom";

/**
 * The filter bar. It only reports intent: every change goes to the host, which
 * turns it into git flags. (Repositories are picked in the RepoPane.)
 */
export class FilterBar {
  private filter: FilterState | undefined;
  private readonly search = byId<HTMLInputElement>("search");
  private readonly author = byId<HTMLInputElement>("author");
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
    // Typing an author replaces Me; Me toggles on and off.
    this.author.addEventListener("input", () => this.emit({ author: this.author.value, mine: false }));
    this.meButton.addEventListener("click", () => this.emit({ mine: !this.current().mine }));
    // A branch applies when committed (Enter, a picked suggestion, leaving the box), not per keystroke.
    this.branch.addEventListener("change", () => this.applyBranch());
    this.branch.addEventListener("input", () => {
      if (this.branch.value === "") this.applyBranch(); // the search box's clear button
      else this.branch.removeAttribute("aria-invalid");
    });
    this.date.addEventListener("change", () => {
      const date = this.date.value as DatePreset;
      const { text, author, mine, branch, repoIds } = this.current();
      this.onChange(date === "custom"
        ? { text, author, mine, branch, repoIds, date, from: this.from.value || undefined, to: this.to.value || undefined }
        : { text, author, mine, branch, repoIds, date });
    });
    for (const input of [this.from, this.to]) {
      input.addEventListener("change", () => this.emit({ from: this.from.value || undefined, to: this.to.value || undefined }));
    }
    byId("refresh").addEventListener("click", onRefresh);
  }

  update(filter: FilterState): void {
    this.filter = filter;
    if (this.search.value !== filter.text) this.search.value = filter.text;
    const shownAuthor = filter.mine ? "" : filter.author;
    if (this.author.value !== shownAuthor) this.author.value = shownAuthor;
    this.author.placeholder = filter.mine ? "Me" : "Author";
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
