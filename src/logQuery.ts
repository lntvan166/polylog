import { logArgs, selectRepos, type FilterState, type RepoCursor } from "./filterModel";
import { parseLog } from "./gitLog";
import { mergeBatches, type RepoBatch } from "./mergeStream";
import { abortError, runPool } from "./pool";
import { commitKey, type Commit, type Repo, type RepoFailure } from "./types";

export type RunGit = (cwd: string, args: string[], signal: AbortSignal) => Promise<string>;

export interface QueryState {
  /** Fixed at the first page so --since does not drift while paging. */
  now: number;
  cursors: Map<string, RepoCursor>;
  seen: Set<string>;
}

export interface PageRequest {
  repos: readonly Repo[];
  filter: FilterState;
  pageSize: number;
  concurrency: number;
  now: number;
  /** null for the first page; the previous page's state for Load More. */
  prev: QueryState | null;
  run: RunGit;
  signal: AbortSignal;
}

export interface PageResult {
  rows: Commit[];
  failures: RepoFailure[];
  state: QueryState;
  done: boolean;
}

/**
 * One page of the merged log: one `git log` per repository, every filter pushed
 * down as git flags, merged in memory. No index, no cache.
 */
export async function fetchPage(req: PageRequest): Promise<PageResult> {
  const { prev } = req;
  const now = prev?.now ?? req.now;
  const targets = prev ? req.repos.filter((r) => prev.cursors.has(r.id)) : selectRepos(req.filter, req.repos);
  const settled = await runPool(
    targets,
    req.concurrency,
    (repo, signal) => req.run(repo.root, logArgs(req.filter, { pageSize: req.pageSize, now, cursor: prev?.cursors.get(repo.id) }), signal),
    req.signal,
  );
  if (req.signal.aborted) throw abortError();

  const batches: RepoBatch[] = [];
  const failures: RepoFailure[] = [];
  settled.forEach((result, i) => {
    const repo = targets[i];
    if (result.status === "fulfilled") {
      const commits = parseLog(result.value, repo.id);
      batches.push({ repoId: repo.id, commits, full: commits.length >= req.pageSize, cursor: prev?.cursors.get(repo.id) });
    } else {
      failures.push({ repoId: repo.id, name: repo.name, reason: result.reason instanceof Error ? result.reason.message : String(result.reason) });
    }
  });

  const seen = new Set(prev?.seen);
  const { rows, cursors } = mergeBatches(batches, seen);
  for (const c of rows) seen.add(commitKey(c));
  return { rows, failures, state: { now, cursors, seen }, done: cursors.size === 0 };
}
