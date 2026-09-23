import type { FilterState } from "../filterModel";
import { commitKey } from "../types";

const pad = (n: number) => String(n).padStart(2, "0");

export function relativeTime(now: number, t: number): string {
  const s = Math.max(0, now - t);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

export function absoluteTime(t: number): string {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, total: number, overscan = 8): { start: number; end: number } {
  if (total === 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(scrollTop / rowHeight);
  const count = Math.ceil(viewport / rowHeight);
  return { start: Math.max(0, first - overscan), end: Math.min(total, first + count + overscan) };
}

export function moveSelection(key: string, index: number, total: number, pageRows: number): number | null {
  if (total === 0) return null;
  const last = total - 1;
  switch (key) {
    case "ArrowDown": return Math.min(last, index + 1);
    case "ArrowUp": return Math.max(0, index - 1);
    case "Home": return 0;
    case "End": return last;
    case "PageDown": return Math.min(last, Math.max(0, index) + pageRows);
    case "PageUp": return Math.max(0, index - pageRows);
    default: return null;
  }
}

/** Six hues: five of VS Code's chart colors plus terminal cyan; see styles.css .accent-0 … .accent-5. */
export const ACCENT_COUNT = 6;

/**
 * Every repository gets a hue (maintainer decision, overriding spec §4's
 * filtered-only rule): its place in the workspace's repo list, cycling through
 * the six hues. When the user filters to six or fewer, hues follow the
 * selection so each chosen repo is distinct. The color is only a marker; the
 * repo name is always printed beside it.
 */
export function accentIndex(repoId: string, repoIds: readonly string[] | null, allRepoIds: readonly string[]): number {
  if (repoIds !== null && repoIds.length <= ACCENT_COUNT) {
    const i = repoIds.indexOf(repoId);
    if (i >= 0) return i;
  }
  return Math.max(0, allRepoIds.indexOf(repoId)) % ACCENT_COUNT;
}

const repoNoun = (n: number) => (n === 1 ? "repository" : "repositories");

export function repoButtonLabel(repoIds: readonly string[] | null, repos: readonly { id: string; name: string }[]): string {
  if (repoIds === null) return "All repositories";
  if (repoIds.length === 0) return "No repositories";
  if (repoIds.length === 1) return repos.find((r) => r.id === repoIds[0])?.name ?? "1 repository";
  return `${repoIds.length} of ${repos.length} repositories`;
}

export function dateLabel(f: FilterState): string {
  switch (f.date) {
    case "24h": return " in the last 24 hours";
    case "7d": return " in the last 7 days";
    case "30d": return " in the last 30 days";
    case "all": return "";
    case "custom":
      if (f.from && f.to) return ` between ${f.from} and ${f.to}`;
      if (f.from) return ` since ${f.from}`;
      if (f.to) return ` until ${f.to}`;
      return "";
  }
}

export type EmptyAction = "clearText" | "clearAuthor" | "allTime" | "selectAll" | "settings";

export interface EmptyState {
  title: string;
  body: string;
  action?: { label: string; id: EmptyAction };
}

export function emptyState(o: { repoCount: number; filter: FilterState; history?: string }): EmptyState {
  const f = o.filter;
  if (o.history !== undefined) {
    const p = o.history;
    const text = f.text.trim();
    if (text) return { title: "No matching commits", body: `No commit to ${p} contains “${text}”.`, action: { label: "Clear Search", id: "clearText" } };
    if (f.date !== "all") return { title: "No commits in this date range", body: `No commits to ${p}${dateLabel(f)}.`, action: { label: "Show All Time", id: "allTime" } };
    return { title: "No matching commits", body: `No commits to ${p} match these filters.`, action: { label: "Clear Author", id: "clearAuthor" } };
  }
  if (o.repoCount === 0) {
    return {
      title: "No git repositories found",
      body: "Polylog lists the repositories that VS Code's Git extension reports. If yours sit deeper in the folder tree, raise git.repositoryScanMaxDepth or polylog.scanDepth.",
      action: { label: "Open Settings", id: "settings" },
    };
  }
  if (f.repoIds !== null && f.repoIds.length === 0) {
    return { title: "No repositories selected", body: "Choose at least one repository to see its commits.", action: { label: "Select All", id: "selectAll" } };
  }
  const k = f.repoIds === null ? o.repoCount : f.repoIds.length;
  const scope = f.repoIds === null ? `${k} ${repoNoun(k)}` : `${k} selected ${repoNoun(k)}`;
  const text = f.text.trim();
  const author = f.mine ? "" : f.author.trim();
  const by = f.mine ? "you" : `“${author}”`;
  if (text && (author || f.mine)) {
    return { title: "No matching commits", body: `No commit by ${by} contains “${text}” in ${scope}${dateLabel(f)}.`, action: { label: "Clear Search", id: "clearText" } };
  }
  if (text) {
    return { title: "No matching commits", body: `No commit message contains “${text}” in ${scope}${dateLabel(f)}.`, action: { label: "Clear Search", id: "clearText" } };
  }
  if (author || f.mine) {
    return { title: "No matching commits", body: `No commits by ${by} in ${scope}${dateLabel(f)}.`, action: { label: "Clear Author", id: "clearAuthor" } };
  }
  if (f.date !== "all") {
    return { title: "No commits in this date range", body: `No commits in ${scope}${dateLabel(f)}.`, action: { label: "Show All Time", id: "allTime" } };
  }
  if (f.repoIds !== null) {
    return { title: "No commits in the selected repositories", body: `The ${scope} have no commits.`, action: { label: "Select All", id: "selectAll" } };
  }
  return {
    title: "No commits yet",
    body: `Polylog shows one merged log across every repository in this workspace. It found ${k} ${repoNoun(k)}, but none has commits yet.`,
  };
}

export function branchUseLabel(u: { branch: string; found: number; fallback: number } | undefined): string {
  if (!u) return "";
  if (u.fallback === 0) return `${u.branch} in all ${u.found} repos`;
  if (u.found === 0) return `no repo has ${u.branch} · current branch in ${u.fallback}`;
  return `${u.branch} in ${u.found} repos · current branch in ${u.fallback}`;
}

export function countLabel(n: number): string {
  return `${n} ${n === 1 ? "commit" : "commits"}`;
}

export function splitPath(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf("/");
  return i < 0 ? { dir: "", base: p } : { dir: p.slice(0, i), base: p.slice(i + 1) };
}

/**
 * Where the selection goes when a whole page arrives (a filter change, a
 * refresh after repositories open or close, a replay): stay on the same commit
 * if it is still listed, otherwise the first row.
 */
export function reselect(prevKey: string | null, rows: readonly { repoId: string; sha: string }[]): number {
  if (rows.length === 0) return -1;
  if (prevKey === null) return 0;
  const i = rows.findIndex((r) => commitKey(r) === prevKey);
  return i < 0 ? 0 : i;
}
