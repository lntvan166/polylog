import { historyArgs, historyPathsArgs, logArgs, parseHistoryPaths, selectRepos, type FilterState } from "./filterModel";
import { countRecords, parseHistory, parseLog } from "./gitLog";
import { takeReady, type RepoProgress } from "./mergeStream";
import { abortError, runPool } from "./pool";
import type { Commit, Repo, RepoFailure } from "./types";

export type RunGit = (cwd: string, args: string[], signal: AbortSignal) => Promise<string>;

export interface QueryState {
  /** Fixed at the first page so --since does not drift while paging. */
  now: number;
  progress: Map<string, RepoProgress>;
  /** File history: every name the file has had, learned on the first page. */
  historyPaths?: string[];
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

/** Branch mode: how many repositories have the branch, and how many fell back to their current branch. */
export interface BranchUse {
  branch: string;
  found: number;
  fallback: number;
}

export interface PageResult {
  branchUse?: BranchUse;
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
  const branch = req.filter.branch;

  // Branch mode, first page: does each repo have the branch? Exit code only
  // (rev-parse --verify --quiet), so no localized error text is parsed.
  if (branch && !req.prev) {
    const repos = [...progress.keys()].map((id) => byId.get(id)!);
    const found = await runPool(repos, req.concurrency,
      (repo, signal) => req.run(repo.root, ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], signal), req.signal);
    if (req.signal.aborted) throw abortError();
    found.forEach((f, i) => { progress.get(repos[i].id)!.ref = f.status === "fulfilled" ? branch : null; });
  }
  // File history, first page: learn every name the file has had (one unfiltered
  // --follow walk), then query all of them like any other log.
  let historyPaths = req.prev?.historyPaths;
  if (req.history && !historyPaths) {
    const repo = byId.get(req.history.repoId);
    const p = repo && progress.get(repo.id);
    if (repo && p) {
      try {
        historyPaths = parseHistoryPaths(await req.run(repo.root, historyPathsArgs(req.history.path, p.ref ?? undefined), req.signal), req.history.path);
      } catch (e) {
        if (req.signal.aborted) throw abortError();
        progress.delete(repo.id);
        failures.push({ repoId: repo.id, name: repo.name, reason: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  const branchUse = (): BranchUse | undefined => {
    if (!branch) return undefined;
    const refs = [...progress.values()].map((p) => p.ref);
    return { branch, found: refs.filter((x) => x).length, fallback: refs.filter((x) => !x).length };
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const targets = [...progress]
      .filter(([, p]) => !p.exhausted && p.pending.length < req.pageSize)
      .map(([id]) => byId.get(id)!);
    const settled = await runPool(
      targets,
      req.concurrency,
      (repo, signal) => {
        const p = progress.get(repo.id)!;
        const o = { pageSize: req.pageSize, now, cursor: { skip: p.fetched }, me: req.me?.get(repo.id), ref: p.ref ?? undefined };
        return req.run(repo.root, req.history ? historyArgs(req.filter, { ...o, paths: historyPaths ?? [req.history.path] }) : logArgs(req.filter, o), signal);
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
        const commits = req.history ? parseHistory(result.value, repo.id, req.history.path) : parseLog(result.value, repo.id);
        if (branch) for (const c of commits) c.ref = p.ref ?? "current branch";
        p.pending.push(...commits);
        if (records < req.pageSize) p.exhausted = true;
      } else {
        progress.delete(repo.id);
        failures.push({ repoId: repo.id, name: repo.name, reason: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      }
    });

    const rows = takeReady(progress);
    const done = [...progress.values()].every((p) => p.exhausted && p.pending.length === 0);
    if (rows.length > 0 || done) return { rows, failures, state: { now, progress, historyPaths }, done, branchUse: branchUse() };
  }
  return { rows: [], failures, state: { now, progress, historyPaths }, done: false, branchUse: branchUse() };
}
