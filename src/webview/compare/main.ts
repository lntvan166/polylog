import "./compare.css";
import { setRemoteNames, type Duplicate, type Pair, type PickerItem, type Side } from "../../compareModel";
import type { CompareMode, CRepoRow, ReposHost, ReposWebview } from "../../compareProtocol";
import { byId, clear, h } from "../dom";
import { BranchPicker } from "./picker";

declare function acquireVsCodeApi(): { postMessage(m: ReposWebview): void };
const vscodeApi = acquireVsCodeApi();
const post = (m: ReposWebview) => vscodeApi.postMessage(m);

let pair: Pair | null = null;
let mode: CompareMode = "files";
let recent: Pair[] = [];
let favorites: string[] = [];
let names: { name: string; count: number }[] = [];
let rows: CRepoRow[] = [];
let selected: string | undefined;
let pickingSide: Side = "left";
/** What the list says when it has no rows (decided by the host, which knows whether a read is done). */
let empty: string | undefined;
let pairKey = "";
/** Repositories whose duplicates are unfolded, and what the host sent for them. */
const open = new Map<string, Duplicate[] | undefined>();

const list = byId("repo-list");
const picker = new BranchPicker(byId("picker"), byId<HTMLInputElement>("picker-search"), byId("picker-items"), choose, (name) => post({ type: "favorite", name }));

function choose(it: PickerItem): void {
  if (it.kind === "pair") return post({ type: "pick", pair: it.pair });
  const other = pickingSide === "left" ? pair?.right : pair?.left;
  const next = pickingSide === "left" ? { left: it.name, right: other ?? "" } : { left: other ?? "", right: it.name };
  if (next.left && next.right) post({ type: "pick", pair: next });
  else {
    // The other side is still empty: ask for it next.
    pair = next;
    renderState();
    openPicker(pickingSide === "left" ? "right" : "left");
  }
}

function openPicker(side: Side): void {
  pickingSide = side;
  post({ type: "wantBranches" });
  picker.open(byId(side === "left" ? "branch-left" : "branch-right"));
}

byId("branch-left").addEventListener("click", () => openPicker("left"));
byId("branch-right").addEventListener("click", () => openPicker("right"));
byId("swap").addEventListener("click", () => post({ type: "swap" }));
byId("refresh").addEventListener("click", () => post({ type: "refresh" }));
byId("mode-files").addEventListener("click", () => post({ type: "mode", mode: "files" }));
byId("mode-commits").addEventListener("click", () => post({ type: "mode", mode: "commits" }));

list.addEventListener("click", (e) => {
  const twisty = (e.target as Element).closest<HTMLElement>("[data-twisty]");
  if (twisty) {
    const id = twisty.dataset.twisty!;
    if (open.has(id)) open.delete(id);
    else {
      open.set(id, undefined);
      post({ type: "wantDups", repoId: id });
    }
    renderRows();
    return;
  }
  const row = (e.target as Element).closest<HTMLElement>("[data-repo]");
  if (row) select(row.dataset.repo!);
});
list.addEventListener("keydown", (e) => {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const i = rows.findIndex((r) => r.repoId === selected);
  const to = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : i + (e.key === "ArrowDown" ? 1 : -1);
  const r = rows[Math.max(0, Math.min(rows.length - 1, to))];
  if (r) select(r.repoId);
});

function select(repoId: string): void {
  if (repoId === selected) return;
  selected = repoId;
  renderRows();
  post({ type: "select", repoId });
}

window.addEventListener("message", (e: MessageEvent<ReposHost>) => {
  const m = e.data;
  switch (m.type) {
    case "state":
      pair = m.pair;
      mode = m.mode;
      recent = m.recent;
      favorites = m.favorites;
      picker.update(names, favorites, recent);
      renderState(m.message);
      return;
    case "branches":
      setRemoteNames(m.remotes);
      names = m.names;
      picker.update(names, favorites, recent);
      return;
    case "repos":
      rows = m.rows;
      selected = m.selected;
      empty = m.empty;
      // Unfolded duplicates belong to one pair and orientation: a new pair or a swap folds them.
      if (m.pairKey !== pairKey) open.clear();
      pairKey = m.pairKey;
      for (const id of [...open.keys()]) if (!rows.some((r) => r.repoId === id)) open.delete(id);
      byId("summary").textContent = m.summary;
      renderState(m.message);
      renderMissing(m.missing);
      renderRows();
      return;
    case "dups":
      if (open.has(m.repoId)) {
        open.set(m.repoId, m.items);
        renderRows();
      }
      return;
    case "openPicker":
      openPicker(m.side);
      return;
  }
});

function renderState(message?: string): void {
  byId("name-left").textContent = pair?.left || "Pick a branch";
  byId("name-right").textContent = pair?.right || "Pick a branch";
  byId("mode-files").setAttribute("aria-pressed", String(mode === "files"));
  byId("mode-commits").setAttribute("aria-pressed", String(mode === "commits"));
  const msg = byId("message");
  msg.hidden = message === undefined;
  msg.textContent = message ?? "";
  list.hidden = byId("summary").hidden = message !== undefined;
}

function renderMissing(missing: string[]): void {
  const el = byId<HTMLDetailsElement>("missing");
  el.hidden = missing.length === 0 || !pair;
  if (!pair) return;
  byId("missing-title").textContent = `Missing a branch: ${missing.length} ${missing.length === 1 ? "repository" : "repositories"}`;
  const ul = byId("missing-list");
  clear(ul);
  for (const n of missing) ul.append(h("li", {}, [n]));
}

/** A count cell: blank when 0, so the columns stay aligned and quiet. */
const cell = (n: number, cls: string, mark: string) => h("span", { class: `count ${cls}` }, [n > 0 ? `${n} ${mark}` : ""]);

function renderRows(): void {
  clear(list);
  if (rows.length === 0 && empty) list.append(h("div", { class: "cempty" }, [empty]));
  rows.forEach((r, i) => {
    const on = r.repoId === selected;
    const dups = r.status === "differs" && r.same > 0;
    const unfolded = open.has(r.repoId);
    list.append(h("div", {
      class: on ? "crepo selected" : "crepo", role: "option", id: `crepo-${i}`, "aria-selected": String(on), "data-repo": r.repoId,
      title: r.status === "differs" ? `${r.name}: ${r.left} only on ${pair?.left}, ${r.right} only on ${pair?.right}, ${r.same} on both (merges not counted)` : r.reason ?? r.name,
      "data-vscode-context": JSON.stringify({ webviewSection: "compareRepo", repoId: r.repoId, behind: r.behind, preventDefaultContextMenuItems: true }),
    }, [
      h("span", { class: "twisty", "data-twisty": dups ? r.repoId : undefined, "aria-hidden": "true" }, [dups ? (unfolded ? "▾" : "▸") : ""]),
      h("span", { class: `repo-dot accent-${r.accent}`, "aria-hidden": "true" }),
      h("span", { class: "repo-name" }, [r.name]),
      ...(r.status === "differs"
        ? [cell(r.left, "left", "◀"), cell(r.right, "right", "▶"), cell(r.same, "same", "=")]
        : [h("span", { class: r.status === "error" ? "row-note error" : "row-note" }, [r.status === "nobase" ? "no common history" : "git error"])]),
    ]));
    if (unfolded) {
      const items = open.get(r.repoId);
      if (!items) list.append(h("div", { class: "dup" }, ["Reading…"]));
      else for (const d of items) list.append(h("div", { class: "dup", title: "The same change committed on each side (cherry-picked)" }, [
        h("span", { class: "same" }, ["="]), h("span", { class: "dup-subject" }, [d.subject]),
        d.left ? h("span", { class: "left mono" }, [`◀ ${d.left.slice(0, 7)}`]) : null,
        d.right ? h("span", { class: "right mono" }, [`▶ ${d.right.slice(0, 7)}`]) : null,
      ]));
    }
  });
  const i = rows.findIndex((r) => r.repoId === selected);
  if (i >= 0) list.setAttribute("aria-activedescendant", `crepo-${i}`);
  else list.removeAttribute("aria-activedescendant");
}

renderState();
post({ type: "ready" });
