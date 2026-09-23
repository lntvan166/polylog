import type { Commit } from "./types";

/** One repository's place in the merged log for the life of one query. */
export interface RepoProgress {
  /** Records consumed from git's walk so far — the next page's --skip. */
  fetched: number;
  /** Fetched but not shown yet: held back by the horizon. */
  pending: Commit[];
  /** git returned a short page: nothing more to fetch. */
  exhausted: boolean;
  /** Branch mode: the ref this repo walks (null = its current branch), resolved on the first page. */
  ref?: string | null;
}

export function compareCommits(a: Commit, b: Commit): number {
  if (a.time !== b.time) return b.time - a.time;
  if (a.sha !== b.sha) return a.sha < b.sha ? -1 : 1;
  return a.repoId < b.repoId ? -1 : a.repoId > b.repoId ? 1 : 0;
}

/**
 * Moves every pending commit at or above the horizon into the returned rows,
 * newest first. The horizon is the highest "oldest pending commit" among
 * repositories that may still have unfetched history: nothing below it can be
 * shown yet, or that history could later land above it. Rows below the horizon
 * stay pending — held, never dropped — so a commit with a skewed clock sinks to
 * its date instead of truncating its repository.
 */
export function takeReady(progress: ReadonlyMap<string, RepoProgress>): Commit[] {
  let horizon = -Infinity;
  for (const p of progress.values()) {
    if (!p.exhausted && p.pending.length > 0) horizon = Math.max(horizon, p.pending.reduce((m, c) => Math.min(m, c.time), Infinity));
  }
  const rows: Commit[] = [];
  for (const p of progress.values()) {
    const held: Commit[] = [];
    for (const c of p.pending) (c.time >= horizon ? rows : held).push(c);
    p.pending = held;
  }
  return rows.sort(compareCommits);
}
