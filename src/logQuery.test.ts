import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_FILTER, type FilterState } from "./filterModel";
import { gitEnv, makeRepo } from "./fixtures";
import { GitError, runGit } from "./git";
import { fetchPage, type QueryState, type RunGit } from "./logQuery";
import { compareCommits } from "./mergeStream";
import { isAbortError } from "./pool";
import { commitKey, type Commit, type Repo } from "./types";

const ALL: FilterState = { ...DEFAULT_FILTER, date: "all" };
const repo = (name: string): Repo => ({ id: `/ws/${name}`, root: `/ws/${name}`, name });
const WEB = repo("acme-web"), API = repo("acme-api"), LIBS = repo("acme-libs");
let serial = 0;
const mk = (r: Repo, time: number, subject = `${r.name}@${time}`): Commit => ({
  repoId: r.id, sha: (++serial).toString(16).padStart(40, "0"), time, author: "rin", email: "rin@example.com", subject, parents: [],
});
const stdout = (cs: Commit[]) => cs.map((c) => [c.sha, c.time, c.author, c.email, c.subject, c.parents.join(" ")].join("\0") + "\x1e\n").join("");
const arg = (args: string[], prefix: string) => args.find((a) => a.startsWith(prefix))?.slice(prefix.length);

/** Stands in for git: honours --max-count, --until and --skip exactly as the real flags do. */
function fakeRun(data: Record<string, Commit[]>, calls: string[][] = [], failing = new Set<string>()): RunGit {
  return async (cwd, args) => {
    calls.push([cwd, ...args]);
    if (failing.has(cwd)) throw new GitError("shallow clone: history is incomplete", 128);
    const max = Number(arg(args, "--max-count="));
    const until = arg(args, "--until=");
    const skip = Number(arg(args, "--skip=") ?? 0);
    let cs = [...(data[cwd] ?? [])].sort(compareCommits);
    if (until) cs = cs.filter((c) => c.time <= Date.parse(until) / 1000);
    return stdout(cs.slice(skip, skip + max));
  };
}
const req = (over: Partial<Parameters<typeof fetchPage>[0]>) => ({
  repos: [WEB, API, LIBS], filter: ALL, pageSize: 200, concurrency: 16, now: 1_790_164_800, prev: null,
  run: fakeRun({}), signal: new AbortController().signal, ...over,
});

(async () => {
  {
    const data = { [WEB.root]: [mk(WEB, 30), mk(WEB, 10)], [API.root]: [mk(API, 20)], [LIBS.root]: [mk(LIBS, 40)] };
    const page = await fetchPage(req({ run: fakeRun(data) }));
    assert.deepStrictEqual(page.rows.map((c) => c.subject), ["acme-libs@40", "acme-web@30", "acme-api@20", "acme-web@10"]);
    assert.deepStrictEqual(page.failures, []);
    assert.strictEqual(page.done, true);
    console.log("ok - fans out to every repo and merges newest first");
  }
  {
    const data = { [WEB.root]: [mk(WEB, 30)], [API.root]: [mk(API, 20)] };
    const page = await fetchPage(req({ run: fakeRun(data, [], new Set([LIBS.root])) }));
    assert.deepStrictEqual(page.rows.map((c) => c.repoId), [WEB.id, API.id]);
    assert.deepStrictEqual(page.failures, [{ repoId: LIBS.id, name: "acme-libs", reason: "shallow clone: history is incomplete" }]);
    assert.ok(!page.state.cursors.has(LIBS.id), "a failed repo is not retried by Load More");
    console.log("ok - one failing repository is reported and excluded, not fatal");
  }
  {
    const calls: string[][] = [];
    await fetchPage(req({ filter: { ...ALL, repoIds: [API.id] }, run: fakeRun({}, calls) }));
    assert.deepStrictEqual(calls.map((c) => c[0]), [API.root]);
    console.log("ok - the repo subset is pushed down: unselected repos are never spawned");
  }
  {
    const data = { [WEB.root]: [mk(WEB, 60), mk(WEB, 40), mk(WEB, 20)], [API.root]: [mk(API, 50), mk(API, 30), mk(API, 10)] };
    const calls: string[][] = [];
    const run = fakeRun(data, calls);
    const filter: FilterState = { ...DEFAULT_FILTER, date: "30d" };
    const now = 1_790_164_800;
    const all: Commit[] = [];
    let prev: QueryState | null = null;
    let pages = 0;
    for (let guard = 0; guard < 10; guard++) {
      const page = await fetchPage(req({ repos: [WEB, API], filter, pageSize: 2, now: now + guard * 1000, prev, run }));
      all.push(...page.rows);
      pages++;
      prev = page.state;
      if (page.done) break;
    }
    assert.ok(pages >= 2);
    assert.strictEqual(new Set(all.map(commitKey)).size, 6, "every commit exactly once");
    assert.deepStrictEqual(all.map((c) => c.time), [60, 50, 40, 30, 20, 10]);
    assert.strictEqual(new Set(calls.map((c) => arg(c, "--since="))).size, 1, "--since stays fixed across pages even as time passes");
    console.log("ok - Load More pages through every repo with a stable --since");
  }
  {
    const ctl = new AbortController();
    ctl.abort();
    const calls: string[][] = [];
    await assert.rejects(fetchPage(req({ run: fakeRun({}, calls), signal: ctl.signal })), (e: unknown) => isAbortError(e));
    assert.strictEqual(calls.length, 0);
    console.log("ok - an aborted query rejects with AbortError and spawns nothing");
  }
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-query-test-"));
    Object.assign(process.env, gitEnv(home));
    const repos = ["acme-web", "acme-api", "acme-libs"].map((name) => ({ id: path.join(home, name), root: path.join(home, name), name }));
    makeRepo(repos[0].root, [{ time: 100, author: "rin", message: "feat: scaffold web" }, { time: 400, author: "dana", message: "fix: guard nil response" }], home);
    makeRepo(repos[1].root, [{ time: 200, author: "dana", message: "feat: scaffold api" }, { time: 500, author: "rin", message: "feat: add retry to uploader" }], home);
    makeRepo(repos[2].root, [{ time: 300, author: "dana", message: "chore: bump deps" }], home);
    const page = await fetchPage({ repos, filter: ALL, pageSize: 200, concurrency: 16, now: 1000, prev: null, run: runGit, signal: new AbortController().signal });
    assert.deepStrictEqual(page.rows.map((c) => c.subject), [
      "feat: add retry to uploader", "fix: guard nil response", "chore: bump deps", "feat: scaffold api", "feat: scaffold web",
    ]);
    console.log("ok - end to end against three real repositories");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
