import type { Repo } from "../types";
import { byId, clear, h } from "./dom";
import { fuzzyMatch, isChecked, pickOnly, toggleRepo, visibleRepos } from "./repoPaneModel";
import { accentIndex } from "./view";

interface Row {
  /** null = the "All repositories" row. */
  id: string | null;
  name: string;
}

/**
 * The Repositories pane: a searchable, multi-pick list that edits the Log's
 * repo filter. Click a name to show only that repo; tick boxes (or
 * Ctrl/Cmd-click) to add and remove. One tab stop, arrow keys inside.
 */
export class RepoPane {
  private readonly filterInput = byId<HTMLInputElement>("repo-filter");
  private readonly list = byId("repo-rows");
  private repos: readonly Repo[] = [];
  private repoIds: string[] | null = null;
  private rows: Row[] = [];
  private active = 0;

  constructor(private readonly onChange: (repoIds: string[] | null) => void) {
    this.filterInput.addEventListener("input", () => {
      this.active = 0;
      this.render();
    });
    this.filterInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.list.focus();
      } else if (e.key === "Enter" && this.filterInput.value.trim() && this.rows.length > 1) {
        // Enter picks the best match (row 0 is "All repositories").
        e.preventDefault();
        this.active = 1;
        this.activate(1, false);
      }
    });
    this.list.addEventListener("click", (e) => {
      const el = (e.target as Element).closest<HTMLElement>("[data-row]");
      if (!el) return;
      const i = Number(el.dataset.row);
      this.active = i;
      const onBox = (e.target as Element).closest(".repo-check") !== null;
      this.activate(i, onBox || e.ctrlKey || e.metaKey);
    });
    this.list.addEventListener("keydown", (e) => this.onKey(e));
  }

  update(repos: readonly Repo[], repoIds: string[] | null): void {
    this.repos = repos;
    this.repoIds = repoIds;
    this.render();
  }

  /** toggle: tick/untick (checkbox, Space, Ctrl/Cmd-click); otherwise show only this repo. */
  private activate(i: number, toggle: boolean): void {
    const row = this.rows[i];
    if (!row) return;
    const allIds = this.repos.map((r) => r.id);
    if (row.id === null) this.onChange(null);
    else this.onChange(toggle ? toggleRepo(this.repoIds, row.id, allIds) : pickOnly(row.id));
  }

  private onKey(e: KeyboardEvent): void {
    const last = this.rows.length - 1;
    const move = (i: number) => {
      e.preventDefault();
      this.active = Math.max(0, Math.min(last, i));
      this.render();
    };
    switch (e.key) {
      case "ArrowDown": return move(this.active + 1);
      case "ArrowUp": return this.active === 0 ? (e.preventDefault(), this.filterInput.focus()) : move(this.active - 1);
      case "Home": return move(0);
      case "End": return move(last);
      case " ": e.preventDefault(); return this.activate(this.active, true);
      case "Enter": e.preventDefault(); return this.activate(this.active, false);
    }
  }

  /** The name with the letters the fuzzy search matched wrapped for highlighting. */
  private highlighted(name: string): (string | HTMLElement)[] {
    const m = this.filterInput.value.trim() ? fuzzyMatch(this.filterInput.value, name) : null;
    if (!m || m.positions.length === 0) return [name];
    const hit = new Set(m.positions);
    const parts: (string | HTMLElement)[] = [];
    let run = "";
    let inHit = false;
    const flush = () => {
      if (run) parts.push(inHit ? h("span", { class: "hit" }, [run]) : run);
      run = "";
    };
    for (let i = 0; i < name.length; i++) {
      if (hit.has(i) !== inHit) {
        flush();
        inHit = hit.has(i);
      }
      run += name[i];
    }
    flush();
    return parts;
  }

  private render(): void {
    const allIds = this.repos.map((r) => r.id);
    this.rows = [{ id: null, name: "All repositories" }, ...visibleRepos(this.repos, this.filterInput.value)];
    this.active = Math.min(this.active, this.rows.length - 1);
    const count = this.repoIds === null ? String(this.repos.length) : `${this.repoIds.length}/${this.repos.length}`;
    clear(this.list);
    this.rows.forEach((row, i) => {
      const checked = row.id === null ? this.repoIds === null : isChecked(this.repoIds, row.id);
      const accent = row.id === null ? null : accentIndex(row.id, this.repoIds, allIds);
      const box = h("input", { type: "checkbox", class: "repo-check", tabindex: "-1", "aria-hidden": "true" });
      box.checked = checked;
      this.list.append(h("div", {
        class: i === this.active ? "repo-row active" : "repo-row",
        role: "option",
        id: `repo-row-${i}`,
        "aria-selected": String(checked),
        "data-row": String(i),
        title: row.id ?? "Show commits from every repository",
      }, [
        box,
        accent === null ? h("span", { class: "repo-dot all", "aria-hidden": "true" }) : h("span", { class: `repo-dot accent-${accent}`, "aria-hidden": "true" }),
        h("span", { class: "repo-name" }, row.id === null ? [row.name] : this.highlighted(row.name)),
        row.id === null ? h("span", { class: "repo-count" }, [count]) : null,
      ]));
    });
    if (this.rows.length === 1 && this.repos.length > 0) this.list.append(h("p", { class: "hint" }, ["No repositories match."]));
    this.list.setAttribute("aria-activedescendant", `repo-row-${this.active}`);
    this.list.querySelector(".repo-row.active")?.scrollIntoView({ block: "nearest" });
  }
}
