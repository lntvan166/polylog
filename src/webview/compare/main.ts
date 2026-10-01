import "./compare.css";
import type { CCommit, CFile, CompareHost, CompareMode, CompareWebview, CRepoRow } from "../../compareProtocol";
import type { Duplicate, Pair, PickerItem, Side } from "../../compareModel";
import { fileTree, type TreeNode } from "../../fileTree";
import type { FileChange } from "../../types";
import { byId, clear, h } from "../dom";
import { relativeTime } from "../view";
import { BranchPicker } from "./picker";

declare function acquireVsCodeApi(): { postMessage(m: CompareWebview): void };
const vscodeApi = acquireVsCodeApi();
const post = (m: CompareWebview) => vscodeApi.postMessage(m);

let pair: Pair | null = null;
let mode: CompareMode = "files";
let recent: Pair[] = [];
let favorites: string[] = [];
let names: { name: string; count: number }[] = [];
let rows: CRepoRow[] = [];
let selected: string | undefined;
let detail: Extract<CompareHost, { type: "detail" }> | undefined;
let expanded: { side: Side; sha: string; files?: CFile[] } | undefined;
let pickingSide: Side = "left";

const repoList = byId("repo-list");
const colLeft = byId("col-left");
const colRight = byId("col-right");
const picker = new BranchPicker(byId("picker"), byId<HTMLInputElement>("picker-search"), byId("picker-items"), choose, (name) => post({ type: "favorite", name }));

function choose(it: PickerItem): void {
  if (it.kind === "pair") post({ type: "pick", pair: it.pair });
  else {
    const other = pickingSide === "left" ? pair?.right : pair?.left;
    const next = pickingSide === "left" ? { left: it.name, right: other ?? "" } : { left: other ?? "", right: it.name };
    if (next.left && next.right) post({ type: "pick", pair: next });
    else {
      pair = next;
      renderState();
      openPicker(pickingSide === "left" ? "right" : "left");
    }
  }
}

function openPicker(side: Side): void {
  pickingSide = side;
  if (names.length === 0) post({ type: "wantBranches" });
  picker.open(byId(side === "left" ? "branch-left" : "branch-right"));
}

byId("branch-left").addEventListener("click", () => openPicker("left"));
byId("branch-right").addEventListener("click", () => openPicker("right"));
byId("swap").addEventListener("click", () => post({ type: "swap" }));
byId("refresh").addEventListener("click", () => post({ type: "refresh" }));
byId("mode-files").addEventListener("click", () => post({ type: "mode", mode: "files" }));
byId("mode-commits").addEventListener("click", () => post({ type: "mode", mode: "commits" }));

repoList.addEventListener("click", (e) => {
  const row = (e.target as Element).closest<HTMLElement>("[data-repo]");
  if (row) select(row.dataset.repo!);
});
repoList.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
  e.preventDefault();
  const i = rows.findIndex((r) => r.repoId === selected);
  const to = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : i + (e.key === "ArrowDown" ? 1 : -1);
  const r = rows[Math.max(0, Math.min(rows.length - 1, to))];
  if (r) select(r.repoId);
});

function select(repoId: string): void {
  if (repoId === selected) return;
  selected = repoId;
  expanded = undefined;
  renderRepos();
  post({ type: "select", repoId });
}

for (const [col, side] of [[colLeft, "left"], [colRight, "right"]] as const) {
  col.addEventListener("click", (e) => activate(e.target as Element, side));
  col.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    activate(e.target as Element, side);
  });
}

function activate(target: Element, side: Side): void {
  if (!selected) return;
  const file = target.closest<HTMLElement>("[data-file]");
  if (file) {
    const sha = file.dataset.sha;
    if (sha) post({ type: "openCommitFile", repoId: selected, sha, path: file.dataset.file! });
    else post({ type: "openFile", repoId: selected, side, path: file.dataset.file! });
    return;
  }
  const more = target.closest<HTMLElement>("[data-more]");
  if (more) {
    post({ type: "more", repoId: selected, side });
    return;
  }
  const commit = target.closest<HTMLElement>("[data-commit]");
  if (commit) {
    const sha = commit.dataset.commit!;
    expanded = expanded?.sha === sha ? undefined : { side, sha };
    if (expanded) post({ type: "expand", repoId: selected, sha });
    renderColumns();
  }
}

window.addEventListener("message", (e: MessageEvent<CompareHost>) => {
  const m = e.data;
  switch (m.type) {
    case "state":
      pair = m.pair;
      mode = m.mode;
      recent = m.recent;
      favorites = m.favorites;
      picker.update(names, favorites, recent);
      renderState(m.message);
      if (!pair?.left) openPicker("left");
      else if (!pair.right) openPicker("right");
      return;
    case "branches":
      names = m.names;
      picker.update(names, favorites, recent);
      return;
    case "repos":
      rows = m.rows;
      if (!rows.some((r) => r.repoId === selected)) {
        selected = rows[0]?.repoId;
        detail = undefined;
      }
      byId("summary").textContent = m.summary;
      renderMissing(m.missing);
      renderRepos();
      renderColumns();
      return;
    case "detail":
      if (m.repoId !== selected) return;
      detail = m;
      renderColumns();
      return;
    case "commitFiles":
      if (m.repoId === selected && expanded?.sha === m.sha) {
        expanded.files = m.files;
        renderColumns();
      }
      return;
  }
});

function renderState(message?: string): void {
  byId("name-left").textContent = pair?.left || "Pick a branch";
  byId("name-right").textContent = pair?.right || "Pick a branch";
  byId("mode-files").setAttribute("aria-pressed", String(mode === "files"));
  byId("mode-commits").setAttribute("aria-pressed", String(mode === "commits"));
  const msg = byId("message");
  const text = message ?? (!pair?.left || !pair?.right ? "Pick the branch to merge from (◀) and the branch it goes into (▶)." : undefined);
  msg.hidden = text === undefined;
  msg.textContent = text ?? "";
  byId("cbody").hidden = text !== undefined;
}

function renderMissing(missing: string[]): void {
  const el = byId<HTMLDetailsElement>("missing");
  el.hidden = missing.length === 0 || !pair;
  if (!pair) return;
  byId("missing-title").textContent = `${pair.left} or ${pair.right} is missing in ${missing.length} ${missing.length === 1 ? "repository" : "repositories"}`;
  const list = byId("missing-list");
  clear(list);
  for (const n of missing) list.append(h("li", {}, [n]));
}

function renderRepos(): void {
  clear(repoList);
  const empty = rows.length === 0 && pair && pair.left && pair.right && pair.left !== pair.right;
  const summary = byId("summary").textContent ?? "";
  if (empty) repoList.append(h("div", { class: "cempty" }, [summary.startsWith("Reading") ? "Reading…" : summary.startsWith("No repositories") ? summary : `${pair!.left} and ${pair!.right} are the same in every repository.`]));
  rows.forEach((r, i) => {
    const on = r.repoId === selected;
    repoList.append(h("div", {
      class: on ? "crepo selected" : "crepo", role: "option", id: `crepo-${i}`, "aria-selected": String(on), "data-repo": r.repoId,
      "data-vscode-context": JSON.stringify({ webviewSection: "compareRepo", repoId: r.repoId, behind: r.behind, preventDefaultContextMenuItems: true }),
    }, [
      chip(r),
      r.status === "differs"
        ? h("span", { class: "counts", "aria-label": `${r.left} left only, ${r.right} right only, ${r.same} on both` }, [
          h("span", { class: "left" }, [`◀${r.left}`]), h("span", { class: "right" }, [`▶${r.right}`]), h("span", { class: "same" }, [`=${r.same}`]),
        ])
        : h("span", { class: r.status === "error" ? "row-note error" : "row-note", title: r.reason ?? "" }, [r.status === "nobase" ? "no common history" : "git error"]),
    ]));
  });
  const i = rows.findIndex((r) => r.repoId === selected);
  if (i >= 0) repoList.setAttribute("aria-activedescendant", `crepo-${i}`);
}

function chip(r: CRepoRow): HTMLElement {
  return h("span", { class: `chip accent-${r.accent}`, title: r.name }, [r.name]);
}

function header(side: Side, count: number): HTMLElement {
  const name = side === "left" ? pair?.left ?? "" : pair?.right ?? "";
  const what = mode === "files" ? `${count} ${count === 1 ? "file" : "files"} · since the split` : `${count} ${count === 1 ? "commit" : "commits"} · ${side === "left" ? "the merge brings these in" : `missing from ${pair?.left ?? ""}`}`;
  return h("div", { class: "colhead" }, [h("b", { class: side }, [`${side === "left" ? "◀" : "▶"} ${name} only`]), h("small", {}, [what])]);
}

function renderColumns(): void {
  const row = rows.find((r) => r.repoId === selected);
  const note = byId("repo-message");
  const columns = byId("columns");
  const dups = byId<HTMLDetailsElement>("dups");
  if (row && row.status !== "differs") {
    note.hidden = false;
    columns.hidden = dups.hidden = true;
    note.textContent = row.status === "nobase"
      ? `${row.name}: ${pair?.left} and ${pair?.right} share no history, so there is no split point. Files and Commits need a common ancestor.`
      : `${row.name}: git could not compare the branches: ${row.reason ?? ""}`;
    return;
  }
  note.hidden = !detail?.error;
  note.textContent = detail?.error ? `git could not read ${row?.name ?? "this repository"}: ${detail.error}` : "";
  columns.hidden = dups.hidden = false;
  for (const [col, side] of [[colLeft, "left"], [colRight, "right"]] as const) {
    clear(col);
    const items = detail?.[side] ?? [];
    col.append(header(side, items.length));
    if (!detail) continue;
    if (items.length === 0) {
      col.append(h("div", { class: "cempty" }, [mode === "files" ? "No file changes on this side."
        : side === "left" ? `Nothing here: ${pair?.right} already has every commit of ${pair?.left}.` : `Nothing here: ${pair?.left} has everything on ${pair?.right}.`]));
      continue;
    }
    if (mode === "files") col.append(tree(fileTree((items as CFile[]).map((f): FileChange => ({ ...f }))), items as CFile[], 0));
    else {
      for (const c of items as CCommit[]) col.append(commitRow(c, side));
      if (detail.more[side]) col.append(h("button", { class: "more", "data-more": side }, ["Show 500 more"]));
    }
  }
  renderDups(detail?.duplicates ?? []);
}

function tree(nodes: TreeNode[], files: CFile[], depth: number): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const n of nodes) {
    if (n.kind === "folder") {
      const el = h("div", { class: "trow folder" }, [h("span", { class: "twisty", "aria-hidden": "true" }, ["▾"]), h("span", {}, [n.name]), h("span", { class: "tcount" }, [String(n.count)])]);
      el.style.paddingLeft = `${12 + depth * 14}px`;
      frag.append(el, tree(n.children, files, depth + 1));
    } else {
      const f = files.find((x) => x.path === n.file.path)!;
      const el = h("div", { class: "trow file", tabindex: "0", role: "button", "data-file": f.path, title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path }, [
        h("span", { class: "tname" }, [n.name]),
        f.oldPath ? h("span", { class: "renamed" }, [`← ${f.oldPath}`]) : null,
        f.both ? h("span", { class: "both", title: "Changed on both sides since the split: look at it before merging" }, ["both"]) : null,
        stat(f),
      ]);
      el.style.paddingLeft = `${12 + depth * 14}px`;
      frag.append(el);
    }
  }
  return frag;
}

function stat(f: { added: number | null; deleted: number | null }): HTMLElement {
  return f.added === null ? h("span", { class: "tstat" }, ["binary"]) : h("span", { class: "tstat" }, [h("span", { class: "added" }, [`+${f.added}`]), " ", h("span", { class: "deleted" }, [`−${f.deleted}`])]);
}

function commitRow(c: CCommit, side: Side): HTMLElement {
  const open = expanded?.sha === c.sha && expanded.side === side;
  const now = Date.now() / 1000;
  return h("div", { class: open ? "ccommit open" : "ccommit", tabindex: "0", role: "button", "aria-expanded": String(open), "data-commit": c.sha }, [
    h("div", { class: "csubject" }, [h("span", { class: "twisty", "aria-hidden": "true" }, [open ? "▾" : "▸"]), h("span", {}, [c.subject])]),
    h("div", { class: "cmeta" }, [h("span", {}, [c.author]), h("span", {}, [relativeTime(now, c.time)])]),
    open ? h("div", { class: "cfiles" }, expanded!.files
      ? expanded!.files.map((f) => h("div", { class: "trow file", tabindex: "0", role: "button", "data-file": f.path, "data-sha": c.sha }, [h("span", { class: "tname mono" }, [f.path]), stat(f)]))
      : [h("div", { class: "cempty" }, ["Reading…"])]) : null,
  ]);
}

function renderDups(d: Duplicate[]): void {
  byId("dups-title").textContent = d.length === 0 ? "= none on both"
    : `= ${d.length} on both — the same change committed on each side (cherry-picked): the merge does not repeat it, but history lists it twice`;
  const list = byId("dups-list");
  clear(list);
  for (const x of d) list.append(h("div", { class: "dup" }, [
    h("span", { class: "same" }, ["="]), h("span", {}, [x.subject]),
    x.left ? h("span", { class: "left mono" }, [`◀ ${x.left.slice(0, 7)}`]) : null,
    x.right ? h("span", { class: "right mono" }, [`▶ ${x.right.slice(0, 7)}`]) : null,
  ]));
}

post({ type: "ready" });
