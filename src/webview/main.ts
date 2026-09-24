import "./styles.css";
// Registers <vscode-checkbox> (VS Code Elements, MIT): the Repositories pane's boxes.
import "@vscode-elements/elements/dist/vscode-checkbox/index.js";
import { DEFAULT_FILTER, type FilterState } from "../filterModel";
import type { HostMessage, WebviewMessage } from "../protocol";
import { commitKey, type Commit, type Repo, type RepoFailure } from "../types";
import { byId } from "./dom";
import { EmptyView } from "./empty";
import { FilterBar } from "./filters";
import { CommitList } from "./list";
import { NoticeBar } from "./notices";
import { RepoPane } from "./repoPane";
import { attachSplitter } from "./splitter";
import { PaneWidth } from "./repoPaneModel";
import { assignAccents, branchUseLabel, repoColumnChars, countLabel, emptyState, reselect, type EmptyAction } from "./view";

const vscode = acquireVsCodeApi();
const post = (m: WebviewMessage): void => vscode.postMessage(m);

/** A 25 ms query should never flash a skeleton. */
const SKELETON_DELAY_MS = 150;

const state = {
  repos: [] as Repo[],
  filter: DEFAULT_FILTER as FilterState,
  history: null as { repoName: string; path: string } | null,
  rows: [] as Commit[],
  failures: [] as RepoFailure[],
  dismissed: false,
  done: true,
  loading: true,
  skeleton: false,
  selected: -1,
  now: Math.floor(Date.now() / 1000),
};

const listEl = byId("list");
const searchEl = byId<HTMLInputElement>("search");
const moreEl = byId<HTMLButtonElement>("more");
const countEl = byId("count");
const branchUseEl = byId("branch-use");
const list = new CommitList(listEl, byId("rows"), (i) => select(i), openFirstFile);
const notices = new NoticeBar(byId("notices"), () => {
  state.dismissed = true;
  render();
});
const empty = new EmptyView(byId("empty"), runEmptyAction);
const filters = new FilterBar(setFilter, () => post({ type: "refresh" }), (kind) => post({ type: "wantSuggestions", kind }));
const repoPane = new RepoPane((repoIds) => setFilter({ ...state.filter, repoIds }));
const appEl = byId("app");
const modebar = byId("modebar");
const historyPath = byId("history-path");
const exitHistory = () => post({ type: "exitHistory" });
byId("mode-all").addEventListener("click", exitHistory);
byId("history-close").addEventListener("click", exitHistory);
const splitter = byId("splitter");
const paneWidth = new PaneWidth();

function showPaneWidth(width: number): void {
  appEl.style.setProperty("--repo-pane-width", `${width}px`);
  splitter.setAttribute("aria-valuenow", String(width));
}
const applyPaneWidth = (width: number) => showPaneWidth(paneWidth.set(width, window.innerWidth));

// Drag (or ←/→) the divider; the width is saved by the host when the gesture ends.
attachSplitter(splitter, { get: () => paneWidth.shown, set: applyPaneWidth, commit: () => post({ type: "layout", repoPaneWidth: paneWidth.shown }) });
window.addEventListener("resize", () => showPaneWidth(paneWidth.fit(window.innerWidth)));
/** Each repository's hue, fixed for the repo list: filtering never recolors (spec §18). */
let accents: ReadonlyMap<string, number> = new Map();
let skeletonTimer: ReturnType<typeof setTimeout> | undefined;
let selectedKey: string | null = null;

moreEl.addEventListener("click", () => {
  if (state.loading) return;
  state.loading = true;
  render();
  post({ type: "loadMore" });
});

window.addEventListener("message", (e: MessageEvent<HostMessage>) => {
  const m = e.data;
  switch (m.type) {
    case "init":
      state.repos = m.repos;
      accents = assignAccents(m.repos);
      // +2: the chip's own padding, so a name that fits is never cut.
      appEl.style.setProperty("--repo-col", `${repoColumnChars(m.repos.map((r) => r.name)) + 2}ch`);
      state.filter = m.filter;
      filters.setMe(m.hasMe);
      filters.setBranches(m.branches);
      filters.setAuthors(m.authors);
      filters.update(m.filter);
      repoPane.update(m.repos, m.filter.repoIds);
      appEl.classList.toggle("no-repos", !m.layout.groupByRepo);
      state.history = m.history;
      modebar.hidden = !m.history;
      appEl.classList.toggle("history", !!m.history);
      historyPath.textContent = m.history ? `${m.history.path} · ${m.history.repoName}` : "";
      applyPaneWidth(m.layout.repoPaneWidth);
      break;
    case "suggestions":
      if (m.authors) filters.setAuthors(m.authors);
      if (m.branches) filters.setBranches(m.branches);
      return;
    case "loading":
      state.loading = true;
      clearTimeout(skeletonTimer);
      skeletonTimer = setTimeout(() => {
        state.skeleton = true;
        render();
      }, SKELETON_DELAY_MS);
      break;
    case "page":
      clearTimeout(skeletonTimer);
      state.loading = false;
      state.skeleton = false;
      state.now = m.now;
      branchUseEl.textContent = branchUseLabel(m.branchUse);
      state.done = m.done;
      if (m.append) {
        state.rows = state.rows.concat(m.rows);
        state.failures = m.failures.length > 0 ? state.failures.concat(m.failures) : state.failures;
      } else {
        const prev = state.rows[state.selected];
        const next = reselect(prev ? commitKey(prev) : null, m.rows);
        const kept = prev !== undefined && next >= 0 && commitKey(m.rows[next]) === commitKey(prev);
        state.rows = m.rows;
        state.failures = m.failures;
        state.dismissed = false;
        if (!kept) list.resetScroll();
        select(next, false);
      }
      break;
  }
  render();
});

function select(index: number, andRender = true): void {
  state.selected = index;
  const c = state.rows[index];
  const key = c ? commitKey(c) : null;
  if (c && key !== selectedKey) post({ type: "select", repoId: c.repoId, sha: c.sha });
  selectedKey = key;
  if (andRender) render();
}

/** Enter: the host opens the selected commit's first text file in the editor area. */
function openFirstFile(): void {
  const c = state.rows[state.selected];
  if (c) post({ type: "openFirst", repoId: c.repoId, sha: c.sha });
}

function setFilter(f: FilterState): void {
  state.filter = f;
  filters.update(f);
  repoPane.update(state.repos, f.repoIds);
  post({ type: "filter", filter: f });
  render();
}

function runEmptyAction(action: EmptyAction): void {
  const f = state.filter;
  switch (action) {
    case "clearText": setFilter({ ...f, text: "" }); return;
    case "clearAuthor": setFilter({ ...f, author: "", mine: false, authors: undefined }); return;
    case "allTime": setFilter({ text: f.text, author: f.author, mine: f.mine, authors: f.authors, path: f.path, branch: f.branch, repoIds: f.repoIds, date: "all" }); return;
    case "clearPath": setFilter({ ...f, path: undefined }); return;
    case "selectAll": setFilter({ ...f, repoIds: null }); return;
    case "settings": post({ type: "openSettings" }); return;
  }
}

function render(): void {
  const names = new Map(state.repos.map((r) => [r.id, r.name]));
  list.update({
    rows: state.rows, repoNames: names, accents,
    historyPath: state.history?.path,
    selected: state.selected, now: state.now,
    skeleton: state.skeleton && state.rows.length === 0,
  });
  empty.render(!state.loading && state.rows.length === 0 ? emptyState({ repoCount: state.repos.length, filter: state.filter, history: state.history?.path }) : null);
  notices.render(state.dismissed ? [] : state.failures);
  moreEl.hidden = state.done || state.rows.length === 0;
  moreEl.disabled = state.loading;
  countEl.textContent = state.rows.length > 0 ? countLabel(state.rows.length) : "";
}

document.addEventListener("keydown", (e) => {
  const t = e.target;
  const typing = t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
  const find = e.key.toLowerCase() === "f" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
  if (find || (e.key === "/" && !typing)) {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
    return;
  }
  if (e.key !== "Escape") return;
  if (t === searchEl && searchEl.value !== "") {
    e.preventDefault();
    setFilter({ ...state.filter, text: "" });
    return;
  }
  if (t instanceof HTMLInputElement && t.id === "author" && t.value !== "") {
    e.preventDefault();
    setFilter({ ...state.filter, author: "" });
    return;
  }
  if (t instanceof HTMLInputElement && t.id === "path" && t.value !== "") {
    e.preventDefault();
    t.value = "";
    t.removeAttribute("aria-invalid");
    setFilter({ ...state.filter, path: undefined });
    return;
  }
  if (t instanceof HTMLInputElement && t.id === "branch" && t.value !== "") {
    e.preventDefault();
    t.value = "";
    setFilter({ ...state.filter, branch: "" });
    return;
  }
  listEl.focus();
});

render();
post({ type: "ready" });
