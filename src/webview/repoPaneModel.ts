// The Repositories pane's selection logic. It only edits the Log's repo filter
// (null = every repo); git does the filtering. Narrowing the pane's own list by
// name is UI, not commit filtering.

export const DEFAULT_REPO_PANE_WIDTH = 190;
const MIN_WIDTH = 120;
const MAX_WIDTH = 480;
/** Room the Log always keeps beside the pane. */
const MIN_LOG_WIDTH = 300;

export function pickOnly(id: string): string[] {
  return [id];
}

export function isChecked(repoIds: readonly string[] | null, id: string): boolean {
  return repoIds === null || repoIds.includes(id);
}

/** Tick or untick one repo; ticking every repo again means All (null). */
export function toggleRepo(repoIds: readonly string[] | null, id: string, allIds: readonly string[]): string[] | null {
  const selected = new Set(repoIds ?? allIds);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  const ordered = allIds.filter((x) => selected.has(x));
  return ordered.length === allIds.length ? null : ordered;
}

export function visibleRepos<T extends { name: string }>(repos: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return q ? repos.filter((r) => r.name.toLowerCase().includes(q)) : [...repos];
}

export function clampPaneWidth(width: number, total: number): number {
  if (!Number.isFinite(width)) return DEFAULT_REPO_PANE_WIDTH;
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, total - MIN_LOG_WIDTH));
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, width)));
}
