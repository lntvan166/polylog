import { DEFAULT_FILTER, type DatePreset, type FilterState } from "../filterModel";
import { byId } from "./dom";

/**
 * The filter bar. It only reports intent: every change goes to the host, which
 * turns it into git flags. (Repositories are picked in the RepoPane.)
 */
export class FilterBar {
  private filter: FilterState | undefined;
  private readonly search = byId<HTMLInputElement>("search");
  private readonly author = byId<HTMLInputElement>("author");
  private readonly meButton = byId<HTMLButtonElement>("me");
  private me: string | undefined;
  private readonly date = byId<HTMLSelectElement>("date");
  private readonly customRange = byId("custom-range");
  private readonly from = byId<HTMLInputElement>("from");
  private readonly to = byId<HTMLInputElement>("to");

  constructor(private readonly onChange: (f: FilterState) => void, onRefresh: () => void) {
    byId("filters").addEventListener("submit", (e) => e.preventDefault());
    this.search.addEventListener("input", () => this.emit({ text: this.search.value }));
    this.author.addEventListener("input", () => this.emit({ author: this.author.value }));
    this.meButton.addEventListener("click", () => {
      if (this.me) this.emit({ author: this.me });
    });
    this.date.addEventListener("change", () => {
      const date = this.date.value as DatePreset;
      const { text, author, repoIds } = this.current();
      this.onChange(date === "custom"
        ? { text, author, repoIds, date, from: this.from.value || undefined, to: this.to.value || undefined }
        : { text, author, repoIds, date });
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
    this.meButton.setAttribute("aria-pressed", String(!!this.me && filter.author === this.me));
    this.date.value = filter.date;
    this.customRange.hidden = filter.date !== "custom";
    this.from.value = filter.from ?? "";
    this.to.value = filter.to ?? "";
  }

  /** The user's git email, from the host; shows the Me button when known. */
  setMe(me: string | undefined): void {
    this.me = me;
    this.meButton.hidden = !me;
    if (me) this.meButton.title = `Only commits by ${me}`;
  }

  private current(): FilterState {
    return this.filter ?? DEFAULT_FILTER;
  }

  private emit(patch: Partial<FilterState>): void {
    this.onChange({ ...this.current(), ...patch });
  }
}
