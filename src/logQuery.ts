import { historyArgs, logArgs, selectRepos, type FilterState } from "./filterModel";
import { countRecords, parseHistory, parseLog } from "./gitLog";
import { takeReady, type RepoProgress } from "./mergeStream";
import { abortError, runPool } from "./pool";
import type { Commit, Repo, RepoFailure } from "./types";

export type RunGit = (cwd: string, args: string[], signal: AbortSignal) => Promise<string>;

export interface QueryState {
  /** Fixed at the first page so --since does not drift while paging. */
  now: number;
  progress: Map<string, RepoProgress>;
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
  /** repo id → that repo's user.email, for the "Me" filter. */
  me?: ReadonlyMap<string, string>;
  /** File history: only this repository, only this path (followed across renames). */
  history?: { repoId: string; path: string } | null;
}

export interface PageResult {
  rows: Commit[];
  failures: RepoFailure[];
  state: QueryState;
  done: boolean;
}

/** Fetch rounds per page; each round drains at least one repo, so this only bounds pathological input. */
const MAX_ROUNDS = 64;

/**
 * One page of the merged log: one `git log` per repository that needs more,
 * every filter pushed down as git flags, merged in memory. No index, no cache —
 * the pending rows live only as long as this query.
 */
export async function fetchPage(req: PageRequest): Promise<PageResult> {
  const now = req.prev?.now ?? req.now;
  const byId = new Map(req.repos.map((r) => [r.id, r]));
  // Copy, so an aborted page leaves the previous state intact.
  const progress = new Map<string, RepoProgress>(
    req.prev
      ? [...req.prev.progress].filter(([id]) => byId.has(id)).map(([id, p]) => [id, { ...p, pending: [...p.pending] }])
      : (req.history ? req.repos.filter((r) => r.id === req.history!.repoId) : selectRepos(req.filter, req.repos))
          // Me: a repo with no user.email has no commits that are "mine".
          .filter((r) => !req.filter.mine || req.me?.has(r.id))
          .map((r) => [r.id, { fetched: 0, pending: [], exhausted: false }]),
  );
  const failures: RepoFailure[] = [];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const targets = [...progress]
      .filter(([, p]) => !p.exhausted && p.pending.length < req.pageSize)
      .map(([id]) => byId.get(id)!);
    const settled = await runPool(
      targets,
      req.concurrency,
      (repo, signal) => {
        const o = { pageSize: req.pageSize, now, cursor: { skip: progress.get(repo.id)!.fetched }, me: req.me?.get(repo.id) };
        return req.run(repo.root, req.history ? historyArgs(req.filter, { ...o, path: req.history.path }) : logArgs(req.filter, o), signal);
      },
      req.signal,
    );
    if (req.signal.aborted) throw abortError();

    settled.forEach((result, i) => {
      const repo = targets[i];
      const p = progress.get(repo.id)!;
      if (result.status === "fulfilled") {
        const records = countRecords(result.value);
        p.fetched += records;
        p.pending.push(...(req.history ? parseHistory(result.value, repo.id, req.history.path) : parseLog(result.value, repo.id)));
        if (records < req.pageSize) p.exhausted = true;
      } else {
        progress.delete(repo.id);
        failures.push({ repoId: repo.id, name: repo.name, reason: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      }
    });

    const rows = takeReady(progress);
    const done = [...progress.values()].every((p) => p.exhausted && p.pending.length === 0);
    if (rows.length > 0 || done) return { rows, failures, state: { now, progress }, done };
  }
  return { rows: [], failures, state: { now, progress }, done: false };
}
