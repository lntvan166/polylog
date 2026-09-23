import "./styles.css";
import { DEFAULT_FILTER, type FilterState } from "../filterModel";
import type { HostMessage, WebviewMessage } from "../protocol";
import { commitKey, type Commit, type FileChange, type Repo, type RepoFailure } from "../types";
import { DetailPane } from "./detail";
import { byId } from "./dom";
import { EmptyView } from "./empty";
import { FilterBar } from "./filters";
import { CommitList } from "./list";
import { NoticeBar } from "./notices";
import { countLabel, emptyState, reselect, type EmptyAction } from "./view";

const vscode = acquireVsCodeApi();
const post = (m: WebviewMessage): void => vscode.postMessage(m);

/** A 25 ms query should never flash a skeleton. */
const SKELETON_DELAY_MS = 150;

interface Detail {
  key: string;
  files?: FileChange[] | null;
  message?: string;
  error?: string;
}

const state = {
  repos: [] as Repo[],
  filter: DEFAULT_FILTER as FilterState,
  rows: [] as Commit[],
  failures: [] as RepoFailure[],
  dismissed: false,
  done: true,
  loading: true,
  skeleton: false,
  selected: -1,
  now: Math.floor(Date.now() / 1000),
  detail: null as Detail | null,
  openWhenLoaded: false,
};

const listEl = byId("list");
const searchEl = byId<HTMLInputElement>("search");
const moreEl = byId<HTMLButtonElement>("more");
const countEl = byId("count");
const list = new CommitList(listEl, byId("rows"), (i) => select(i), openFirstFile);
const detail = new DetailPane(byId("detail"), (f) => {
  const c = state.rows[state.selected];
  if (c) openFile(c, f);
});
const notices = new NoticeBar(byId("notices"), () => {
  state.dismissed = true;
  render();
});
const empty = new EmptyView(byId("empty"), runEmptyAction);
const filters = new FilterBar(setFilter, () => post({ type: "refresh" }));
let skeletonTimer: ReturnType<typeof setTimeout> | undefined;

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
      state.filter = m.filter;
      filters.update(m.filter, m.repos);
      break;
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
    case "detail":
      if (state.detail?.key === commitKey(m)) {
        state.detail = { key: state.detail.key, files: m.files, message: m.message, error: m.error };
        if (state.openWhenLoaded) {
          state.openWhenLoaded = false;
          openFirstFile();
        }
      }
      break;
  }
  render();
});

function select(index: number, andRender = true): void {
  state.selected = index;
  const c = state.rows[index];
  if (!c) {
    state.detail = null;
  } else if (state.detail?.key !== commitKey(c)) {
    state.detail = { key: commitKey(c) };
    state.openWhenLoaded = false;
    post({ type: "select", repoId: c.repoId, sha: c.sha });
  }
  if (andRender) render();
}

function openFile(c: Commit, f: FileChange): void {
  post({ type: "openFile", repoId: c.repoId, sha: c.sha, parent: c.parents[0] ?? null, path: f.path, oldPath: f.oldPath });
}

/** Enter: open the selected commit's first text file, waiting for its file list if needed. */
function openFirstFile(): void {
  const c = state.rows[state.selected];
  if (!c || !state.detail) return;
  if (state.detail.files === undefined) {
    state.openWhenLoaded = true;
    return;
  }
  const f = state.detail.files?.find((x) => x.added !== null);
  if (f) openFile(c, f);
}

function setFilter(f: FilterState): void {
  state.filter = f;
  filters.update(f, state.repos);
  post({ type: "filter", filter: f });
  render();
}

function runEmptyAction(action: EmptyAction): void {
  const f = state.filter;
  switch (action) {
    case "clearText": setFilter({ ...f, text: "" }); return;
    case "allTime": setFilter({ text: f.text, repoIds: f.repoIds, date: "all" }); return;
    case "selectAll": setFilter({ ...f, repoIds: null }); return;
    case "settings": post({ type: "openSettings" }); return;
  }
}

function render(): void {
  const names = new Map(state.repos.map((r) => [r.id, r.name]));
  list.update({
    rows: state.rows, repoNames: names, repoIds: state.filter.repoIds, repoOrder: state.repos.map((r) => r.id),
    selected: state.selected, now: state.now,
    skeleton: state.skeleton && state.rows.length === 0,
  });
  empty.render(!state.loading && state.rows.length === 0 ? emptyState({ repoCount: state.repos.length, filter: state.filter }) : null);
  const c = state.rows[state.selected] ?? null;
  detail.render(c, c ? names.get(c.repoId) ?? c.repoId : "", state.detail?.files, state.detail?.error, state.detail?.message);
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
  if (filters.closeMenu()) {
    e.preventDefault();
    return;
  }
  if (t === searchEl && searchEl.value !== "") {
    e.preventDefault();
    setFilter({ ...state.filter, text: "" });
    return;
  }
  listEl.focus();
});

render();
post({ type: "ready" });
