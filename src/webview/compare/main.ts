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
    // The other side is still empty: the host keeps the half pair (and its guidance); ask for the other side.
    pair = next;
    post({ type: "pending", pair: next });
    openPicker(pickingSide === "left" ? "right" : "left");
  }
}

/** Branch names are read when the picker first opens, and again after Refresh. */
let namesWanted = false;

function openPicker(side: Side): void {
  pickingSide = side;
  if (!namesWanted) {
    namesWanted = true;
    post({ type: "wantBranches" });
  }
  picker.open(byId(side === "left" ? "branch-left" : "branch-right"));
}

byId("branch-left").addEventListener("click", () => openPicker("left"));
byId("branch-right").addEventListener("click", () => openPicker("right"));
byId("swap").addEventListener("click", () => post({ type: "swap" }));
byId("refresh").addEventListener("click", () => {
  namesWanted = false;
  post({ type: "refresh" });
});
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
  // → / ← unfold and fold the selected repository's duplicates (the twisty, by keyboard).
  if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && selected) {
    const r = rows.find((x) => x.repoId === selected);
    if (!r || r.status !== "differs" || r.same === 0) return;
    e.preventDefault();
    if (e.key === "ArrowRight" && !open.has(r.repoId)) {
      open.set(r.repoId, undefined);
      post({ type: "wantDups", repoId: r.repoId });
    } else if (e.key === "ArrowLeft") open.delete(r.repoId);
    renderRows();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
  e.preventDefault();
  const i = rows.findIndex((r) => r.repoId === selected);
  const to = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : i + (e.key === "ArrowDown" ? 1 : -1);
  const r = rows[Math.max(0, Math.min(rows.length - 1, to))];
  if (r) select(r.repoId);
});

/** Selections sent and not yet echoed back by the host: an older echo must not undo a newer pick. */
let pendingSelects = 0;

function select(repoId: string): void {
  if (repoId === selected) return;
  selected = repoId;
  pendingSelects++;
  renderRows();
  byId(`crepo-${rows.findIndex((r) => r.repoId === repoId)}`).scrollIntoView({ block: "nearest" });
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
      picker.update(names, favorites, recent, true);
      return;
    case "repos":
      rows = m.rows;
      // Our own picks come back one echo each; until the last one does, the page's choice stands.
      if (pendingSelects > 0 && m.selected !== undefined && rows.some((r) => r.repoId === selected)) pendingSelects--;
      else selected = m.selected;
      empty = m.empty;
      // Unfolded duplicates belong to one pair and orientation: a new pair or a swap folds them.
      if (m.pairKey !== pairKey) open.clear();
      pairKey = m.pairKey;
      for (const id of [...open.keys()]) if (!rows.some((r) => r.repoId === id)) open.delete(id);
      byId("summary").textContent = m.summary;
      // Announced once the read is done, not every 80 ms while it runs.
      byId("summary").setAttribute("aria-busy", String(m.reading));
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


function renderRows(): void {
  clear(list);
  if (rows.length === 0 && empty) list.append(h("div", { class: "cempty", role: "presentation" }, [empty]));
  rows.forEach((r, i) => {
    const on = r.repoId === selected;
    const dups = r.status === "differs" && r.same > 0;
    const unfolded = open.has(r.repoId);
    list.append(h("div", {
      class: on ? "crepo selected" : "crepo", role: "option", id: `crepo-${i}`, "aria-selected": String(on), "data-repo": r.repoId,
      "aria-expanded": dups ? String(unfolded) : undefined,
      title: r.status === "differs" ? `${r.name}: ${r.left} only on ${pair?.left}, ${r.right} only on ${pair?.right}, ${r.same} on both (merges not counted)` : r.reason ?? r.name,
      "data-vscode-context": JSON.stringify({ webviewSection: "compareRepo", repoId: r.repoId, behind: r.behind, preventDefaultContextMenuItems: true }),
    }, [
      h("span", { class: "twisty", "data-twisty": dups ? r.repoId : undefined, "aria-hidden": "true" }, [dups ? (unfolded ? "▾" : "▸") : ""]),
      h("span", { class: `repo-dot accent-${r.accent}`, "aria-hidden": "true" }),
      h("span", { class: "repo-name" }, [r.name]),
      // Names only: commit counts mislead when the same change travels by cherry-pick (they are in the tooltip).
      r.status === "differs" ? null : h("span", { class: r.status === "error" ? "row-note error" : "row-note" }, [r.status === "nobase" ? "no common history" : "git error"]),
    ]));
    if (unfolded) {
      const items = open.get(r.repoId);
      // Not options of the listbox: presentation rows, read with their repository.
      if (!items) list.append(h("div", { class: "dup", role: "presentation" }, ["Reading…"]));
      else for (const d of items) list.append(h("div", { class: "dup", role: "presentation", title: "The same change committed on each side (cherry-picked)" }, [
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
