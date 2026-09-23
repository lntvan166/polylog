import { DEFAULT_FILTER, type DatePreset, type FilterState } from "../filterModel";
import type { Repo } from "../types";
import { byId, clear, h } from "./dom";
import { repoButtonLabel } from "./view";

/**
 * The filter bar. It only reports intent: every change goes to the host, which
 * turns it into git flags. Filtering the repo *menu* by name here is UI, not
 * commit filtering.
 */
export class FilterBar {
  private filter: FilterState | undefined;
  private repos: readonly Repo[] = [];
  private readonly search = byId<HTMLInputElement>("search");
  private readonly author = byId<HTMLInputElement>("author");
  private readonly meButton = byId<HTMLButtonElement>("me");
  private me: string | undefined;
  private readonly date = byId<HTMLSelectElement>("date");
  private readonly customRange = byId("custom-range");
  private readonly from = byId<HTMLInputElement>("from");
  private readonly to = byId<HTMLInputElement>("to");
  private readonly repoButton = byId<HTMLButtonElement>("repo-button");
  private readonly menu = byId("repo-menu");
  private readonly repoSearch = byId<HTMLInputElement>("repo-search");
  private readonly repoList = byId("repo-list");

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
    this.repoButton.addEventListener("click", () => (this.menu.hidden ? this.openMenu() : this.closeMenu()));
    this.repoSearch.addEventListener("input", () => this.renderRepoList());
    byId("repo-all").addEventListener("click", () => this.emit({ repoIds: null }));
    byId("repo-none").addEventListener("click", () => this.emit({ repoIds: [] }));
    this.repoList.addEventListener("change", (e) => {
      const box = e.target as HTMLInputElement;
      this.toggleRepo(box.value, box.checked);
    });
    document.addEventListener("mousedown", (e) => {
      if (!this.menu.hidden && !(e.target as Element).closest(".repo-picker")) this.closeMenu(false);
    });
    byId("refresh").addEventListener("click", onRefresh);
  }

  update(filter: FilterState, repos: readonly Repo[]): void {
    const reposChanged = repos !== this.repos;
    this.filter = filter;
    this.repos = repos;
    if (this.search.value !== filter.text) this.search.value = filter.text;
    if (this.author.value !== filter.author) this.author.value = filter.author;
    this.meButton.setAttribute("aria-pressed", String(!!this.me && filter.author === this.me));
    this.date.value = filter.date;
    this.customRange.hidden = filter.date !== "custom";
    this.from.value = filter.from ?? "";
    this.to.value = filter.to ?? "";
    this.repoButton.textContent = repoButtonLabel(filter.repoIds, repos);
    if (this.menu.hidden) return;
    if (reposChanged) this.renderRepoList();
    else this.syncChecks();
  }

  /** The user's git email, from the host; shows the Me button when known. */
  setMe(me: string | undefined): void {
    this.me = me;
    this.meButton.hidden = !me;
    if (me) this.meButton.title = `Only commits by ${me}`;
  }

  /** Returns true if a menu was open (so Escape was consumed). */
  closeMenu(returnFocus = true): boolean {
    if (this.menu.hidden) return false;
    this.menu.hidden = true;
    this.repoButton.setAttribute("aria-expanded", "false");
    if (returnFocus) this.repoButton.focus();
    return true;
  }

  /** Before the host's init arrives, input edits the defaults rather than throwing. */
  private current(): FilterState {
    return this.filter ?? DEFAULT_FILTER;
  }

  private emit(patch: Partial<FilterState>): void {
    this.onChange({ ...this.current(), ...patch });
  }

  private openMenu(): void {
    this.menu.hidden = false;
    this.repoButton.setAttribute("aria-expanded", "true");
    this.repoSearch.value = "";
    this.renderRepoList();
    this.repoSearch.focus();
  }

  private isChecked(id: string): boolean {
    const ids = this.current().repoIds;
    return ids === null || ids.includes(id);
  }

  private renderRepoList(): void {
    const q = this.repoSearch.value.trim().toLowerCase();
    const shown = this.repos.filter((r) => r.name.toLowerCase().includes(q));
    clear(this.repoList);
    if (shown.length === 0) {
      this.repoList.append(h("p", { class: "hint" }, ["No repositories match."]));
      return;
    }
    for (const r of shown) {
      const box = h("input", { type: "checkbox", value: r.id });
      box.checked = this.isChecked(r.id);
      this.repoList.append(h("label", { class: "repo-option", title: r.root }, [box, h("span", {}, [r.name])]));
    }
  }

  private syncChecks(): void {
    for (const box of this.repoList.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
      box.checked = this.isChecked(box.value);
    }
  }

  private toggleRepo(id: string, checked: boolean): void {
    const selected = new Set(this.current().repoIds ?? this.repos.map((r) => r.id));
    if (checked) selected.add(id);
    else selected.delete(id);
    const ids = this.repos.map((r) => r.id).filter((x) => selected.has(x));
    this.emit({ repoIds: ids.length === this.repos.length ? null : ids });
  }
}
