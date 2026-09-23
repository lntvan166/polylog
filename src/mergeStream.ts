import type { RepoCursor } from "./filterModel";
import { commitKey, type Commit } from "./types";

export interface RepoBatch {
  repoId: string;
  commits: Commit[];
  /** The query returned a full page, so the repository may have more. */
  full: boolean;
  /** The cursor this batch was fetched with (absent on the first page). */
  cursor?: RepoCursor;
}

export interface MergeResult {
  rows: Commit[];
  /** Next-page cursors, only for repositories with more to show. */
  cursors: Map<string, RepoCursor>;
}

export function compareCommits(a: Commit, b: Commit): number {
  if (a.time !== b.time) return b.time - a.time;
  if (a.sha !== b.sha) return a.sha < b.sha ? -1 : 1;
  return a.repoId < b.repoId ? -1 : a.repoId > b.repoId ? 1 : 0;
}

export function mergeBatches(batches: readonly RepoBatch[], seen: ReadonlySet<string>): MergeResult {
  // The horizon: no row older than the oldest commit of any repository that may
  // still have unfetched history, or that history would later land above it.
  let horizon = -Infinity;
  for (const b of batches) {
    if (b.full && b.commits.length > 0) horizon = Math.max(horizon, b.commits.reduce((m, c) => Math.min(m, c.time), Infinity));
  }

  const rows: Commit[] = [];
  const cursors = new Map<string, RepoCursor>();
  for (const b of batches) {
    let cut = false;
    let atHorizon = 0;
    for (const c of b.commits) {
      if (c.time < horizon) {
        cut = true;
        continue;
      }
      if (c.time === horizon) atHorizon++;
      if (!seen.has(commitKey(c))) rows.push(c);
    }
    if (b.full || cut) {
      // --until is inclusive, so skip the commits at exactly `horizon` already
      // consumed — including those skipped by this batch's own cursor.
      const carried = b.cursor && b.cursor.until === horizon ? b.cursor.skip : 0;
      cursors.set(b.repoId, { until: horizon, skip: carried + atHorizon });
    }
  }
  rows.sort(compareCommits);
  return { rows, cursors };
}
