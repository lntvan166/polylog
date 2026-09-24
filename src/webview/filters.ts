import { DEFAULT_FILTER, isValidRef, normalizePath, type DatePreset, type FilterState } from "../filterModel";
import type { AuthorName, BranchName } from "../protocol";
import { byId, clear, h } from "./dom";
import { SuggestBox } from "./suggest";
import type { Suggestion } from "./suggestModel";
import { chipsThatFit } from "./view";

/** The typing room the Author input keeps beside the chips. */
const AUTHOR_INPUT_MIN = 56;

/**
 * The filter bar. It only reports intent: every change goes to the host, which
 * turns it into git flags. (Repositories are picked in the RepoPane.)
 */
export class FilterBar {
  private filter: FilterState | undefined;
  private readonly search = byId<HTMLInputElement>("search");
  private readonly author = byId<HTMLInputElement>("author");
  private readonly authorChips = byId("author-chips");
  private readonly authorField = byId("author-field");
  private authorItems: Suggestion[] = [];
  private branchItems: Suggestion[] = [];
  private readonly meButton = byId<HTMLButtonElement>("me");
  private readonly path = byId<HTMLInputElement>("path");
  private readonly branch = byId<HTMLInputElement>("branch");
  private readonly date = byId<HTMLSelectElement>("date");
  private readonly customRange = byId("custom-range");
  private readonly from = byId<HTMLInputElement>("from");
  private readonly to = byId<HTMLInputElement>("to");

  private readonly authorSuggest: SuggestBox;
  private readonly branchSuggest: SuggestBox;

  constructor(private readonly onChange: (f: FilterState) => void, onRefresh: () => void, onWantSuggestions: (kind: "authors" | "branches") => void) {
    // Suggestions load the first time a box is focused; the host reads them once per repo set.
    this.author.addEventListener("focus", () => onWantSuggestions("authors"));
    this.branch.addEventListener("focus", () => onWantSuggestions("branches"));
    byId("filters").addEventListener("submit", (e) => e.preventDefault());
    this.search.addEventListener("input", () => this.emit({ text: this.search.value }));
    // A wider or narrower bar re-decides which chips fit.
    new ResizeObserver(() => this.fitChips()).observe(this.authorField);
    // Suggestions in VS Code's own style. Created first: their keys (Enter picks) run first.
    this.authorSuggest = new SuggestBox(this.author, this.authorField,
      () => ({ items: this.authorItems, exclude: this.current().authors }), (v) => this.addAuthor(v));
    this.branchSuggest = new SuggestBox(this.branch, this.branch, () => ({ items: this.branchItems }), (v) => {
      this.branch.value = v;
      this.applyBranch();
    });
    // Typing filters as you go (debounced by the host). Enter, a comma or a picked
    // suggestion turns it into a chip, and the next author can be typed.
    this.author.addEventListener("input", (e) => {
      const v = this.author.value;
      // A comma ends each author before it. A pasted list ("rin, sam") is all chips; while
      // typing, the part after the last comma is still being typed.
      if (v.includes(",")) {
        const parts = v.split(",");
        const pasted = (e as InputEvent).inputType === "insertFromPaste";
        const rest = pasted ? "" : (parts.pop() ?? "").trimStart();
        this.addAuthors(parts, rest);
      } else if (/^\s/.test(v) && (this.current().authors ?? []).length > 0) {
        this.author.value = v.trimStart(); // the space after "rin, "
        this.emit({ author: this.author.value });
      } else {
        this.emit({ author: v });
      }
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
    // A path filters as you type (debounced by the host); an unsafe one is marked, not sent.
    this.path.addEventListener("input", () => {
      const raw = this.path.value;
      const p = normalizePath(raw);
      if (raw.trim() !== "" && p === undefined) {
        this.path.setAttribute("aria-invalid", "true");
        this.path.title = "Relative to each repository: no leading / or :, and no ..";
        return;
      }
      this.path.removeAttribute("aria-invalid");
      this.path.title = "";
      if (p !== this.current().path) this.emit({ path: p });
    });
    // A branch applies when committed (Enter, a picked suggestion, leaving the box), not per keystroke.
    this.branch.addEventListener("change", () => this.applyBranch());
    this.branch.addEventListener("input", () => {
      if (this.branch.value === "") this.applyBranch(); // the search box's clear button
      else this.branch.removeAttribute("aria-invalid");
    });
    this.date.addEventListener("change", () => {
      const date = this.date.value as DatePreset;
      const { text, author, mine, authors, path, branch, repoIds } = this.current();
      this.onChange(date === "custom"
        ? { text, author, mine, authors, path, branch, repoIds, date, from: this.from.value || undefined, to: this.to.value || undefined }
        : { text, author, mine, authors, path, branch, repoIds, date });
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
    // Keep what is being typed (it may still be invalid); follow the filter otherwise.
    if (document.activeElement !== this.path && normalizePath(this.path.value) !== filter.path) {
      this.path.value = filter.path ?? "";
      this.path.removeAttribute("aria-invalid");
    }
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
    this.branchSuggest.close();
    if (b !== this.current().branch) this.emit({ branch: b });
  }

  /** Suggestions for the Branch box: names shared by the most repositories first. */
  setBranches(items: readonly BranchName[]): void {
    this.branchItems = items.map((b) => ({ value: b.name, label: b.name, detail: `${b.count} ${b.count === 1 ? "repo" : "repos"}` }));
    this.branchSuggest.refresh();
  }

  /** Suggestions for the Author box: people who committed recently, most commits first. */
  setAuthors(items: readonly AuthorName[]): void {
    this.authorItems = items.map((a) => ({ value: a.name, label: a.name, detail: `${a.email} · ${a.count}` }));
    this.authorSuggest.refresh();
  }

  private addAuthor(raw: string): void {
    this.addAuthors([raw], "");
  }

  /** Adds each name as a chip (skipping blanks and repeats) and leaves `rest` being typed. */
  private addAuthors(raws: readonly string[], rest: string): void {
    const next = [...(this.current().authors ?? [])];
    for (const raw of raws) {
      const name = raw.trim();
      if (name && !next.some((c) => c.toLowerCase() === name.toLowerCase())) next.push(name);
    }
    this.author.value = rest;
    this.authorSuggest.close(); // the text it was suggesting for is gone
    this.emit({ authors: next.length > 0 ? next : undefined, author: rest });
  }

  private removeAuthor(i: number): void {
    const next = (this.current().authors ?? []).filter((_, k) => k !== i);
    this.emit({ authors: next.length > 0 ? next : undefined });
    this.author.focus();
  }

  private renderChips(chips: readonly string[]): void {
    const shown = [...this.authorChips.querySelectorAll<HTMLElement>(".author-chip[data-name]")].map((c) => c.dataset.name);
    if (shown.length === chips.length && shown.every((n, i) => n === chips[i])) return;
    clear(this.authorChips);
    chips.forEach((name, i) => {
      this.authorChips.append(h("span", { class: "author-chip", role: "listitem", "data-name": name, title: name }, [
        h("span", { class: "author-chip-name" }, [name]),
        h("button", { class: "author-chip-remove", type: "button", "data-chip": String(i), "aria-label": `Remove author ${name}`, title: `Remove ${name}` }, ["×"]),
      ]));
    });
    this.authorChips.append(h("span", { class: "author-chip more", role: "listitem", hidden: true }));
    this.fitChips();
  }

  /**
   * Chips keep their width (a sliver of a name tells nobody anything): the ones that do not
   * fit beside the input collapse into a "+N" chip whose tooltip names them.
   */
  private fitChips(): void {
    const chips = [...this.authorChips.querySelectorAll<HTMLElement>(".author-chip[data-name]")];
    const more = this.authorChips.querySelector<HTMLElement>(".author-chip.more");
    if (!more) return;
    for (const c of chips) c.hidden = false;
    more.hidden = false;
    more.textContent = `+${chips.length}`;
    const field = this.authorField;
    const style = getComputedStyle(field);
    const room = field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - AUTHOR_INPUT_MIN;
    const gap = parseFloat(getComputedStyle(this.authorChips).columnGap) || 0;
    const fit = chipsThatFit(chips.map((c) => c.offsetWidth), room, more.offsetWidth, gap);
    chips.forEach((c, i) => (c.hidden = i >= fit));
    const hidden = chips.slice(fit).map((c) => c.dataset.name ?? "");
    more.hidden = hidden.length === 0;
    more.textContent = `+${hidden.length}`;
    more.title = hidden.join(", ");
    more.setAttribute("aria-label", `${hidden.length} more: ${hidden.join(", ")}`);
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
