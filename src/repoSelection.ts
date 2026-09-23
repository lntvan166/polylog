import { accentIndex } from "./webview/view";

/** Tree id of the "All repositories" node. Cannot collide with a repo id (an absolute path). */
export const ALL_REPOS = "polylog:all";

/** Theme color ids in the same order as styles.css .accent-0 … .accent-5. */
export const CHART_COLORS = ["charts.red", "charts.blue", "charts.yellow", "charts.green", "charts.purple", "charts.orange"] as const;

/** Repositories-tree selection → the Log's repo filter (null = every repo). */
export function repoIdsFromSelection(selected: readonly string[]): string[] | null {
  if (selected.length === 0 || selected.includes(ALL_REPOS)) return null;
  return [...new Set(selected)];
}

/** The Log's repo filter → which tree nodes are selected. */
export function selectionFromRepoIds(repoIds: readonly string[] | null, allIds: readonly string[]): string[] {
  if (repoIds === null) return [ALL_REPOS];
  const known = new Set(allIds);
  return repoIds.filter((id) => known.has(id));
}

/** A repo's name color in the tree: the same hue as its chip in the Log. */
export function repoColor(repoId: string, repoIds: readonly string[] | null, allIds: readonly string[]): string {
  return CHART_COLORS[accentIndex(repoId, repoIds, allIds)];
}
