import * as assert from "assert";
import { compareCommits, mergeBatches, type RepoBatch } from "./mergeStream";
import type { RepoCursor } from "./filterModel";
import { commitKey, type Commit } from "./types";

let serial = 0;
const mk = (repoId: string, time: number): Commit => ({
  repoId, time, sha: (++serial).toString(16).padStart(40, "0"),
  author: "dana", email: "dana@example.com", subject: `${repoId}@${time}`, parents: [],
});
const batch = (repoId: string, commits: Commit[], full: boolean, cursor?: RepoCursor): RepoBatch => ({ repoId, commits, full, cursor });
const keys = (cs: Commit[]) => cs.map(commitKey);

// ── Ordering: newest first across repos ─────────────────────────────────────
{
  const web = [mk("web", 50), mk("web", 10)];
  const api = [mk("api", 40), mk("api", 20)];
  const r = mergeBatches([batch("web", web, false), batch("api", api, false)], new Set());
  assert.deepStrictEqual(r.rows.map((c) => c.time), [50, 40, 20, 10]);
  assert.strictEqual(r.cursors.size, 0, "nothing full, nothing cut → done");
  console.log("ok - merges repos newest first; exhausted repos get no cursor");
}

// ── Equal timestamps: stable tie-break on SHA ───────────────────────────────
{
  const a = { ...mk("web", 7), sha: "f".repeat(40) };
  const b = { ...mk("api", 7), sha: "0".repeat(40) };
  const r = mergeBatches([batch("web", [a], false), batch("api", [b], false)], new Set());
  assert.deepStrictEqual(r.rows.map((c) => c.sha), [b.sha, a.sha]);
  assert.ok(compareCommits(b, a) < 0);
  console.log("ok - equal timestamps are ordered by SHA");
}

// ── Empty inputs ────────────────────────────────────────────────────────────
{
  assert.deepStrictEqual(mergeBatches([], new Set()), { rows: [], cursors: new Map() });
  const r = mergeBatches([batch("web", [], false)], new Set());
  assert.deepStrictEqual(r.rows, []);
  assert.strictEqual(r.cursors.size, 0);
  console.log("ok - no batches or an empty repo yields nothing and is done");
}

// ── Single repo passes through ──────────────────────────────────────────────
{
  const cs = [mk("web", 3), mk("web", 2), mk("web", 1)];
  assert.deepStrictEqual(keys(mergeBatches([batch("web", cs, false)], new Set()).rows), keys(cs));
  console.log("ok - a single repository passes through unchanged");
}

// ── Horizon: older rows wait until the full repo catches up ─────────────────
{
  const full = [mk("web", 900), mk("web", 500)];
  const shortRepo = [mk("api", 800), mk("api", 400)];
  const r = mergeBatches([batch("web", full, true), batch("api", shortRepo, false)], new Set());
  assert.deepStrictEqual(r.rows.map((c) => c.time), [900, 800, 500]);
  assert.deepStrictEqual(r.cursors.get("web"), { until: 500, skip: 1 });
  assert.deepStrictEqual(r.cursors.get("api"), { until: 500, skip: 0 }, "cut rows keep a cursor even though the repo was not full");
  console.log("ok - rows older than the horizon are held back with a cursor");
}

// ── Already-shown rows are not repeated ─────────────────────────────────────
{
  const c = mk("web", 5);
  const r = mergeBatches([batch("web", [c, mk("web", 4)], false)], new Set([commitKey(c)]));
  assert.deepStrictEqual(r.rows.map((x) => x.time), [4]);
  console.log("ok - commits in `seen` are not emitted again");
}

// ── Property: paging to the end reproduces the global order exactly ────────
// Simulates git: commits at or before `until`, skip `skip`, take pageSize.
function fakeGit(all: Commit[], pageSize: number, cursor?: RepoCursor) {
  let list = [...all].sort(compareCommits);
  if (cursor) list = list.filter((c) => c.time <= cursor.until).slice(cursor.skip);
  const commits = list.slice(0, pageSize);
  return { commits, full: commits.length === pageSize };
}
function pageAll(repos: Record<string, Commit[]>, pageSize: number): Commit[][] {
  const seen = new Set<string>();
  let cursors: Map<string, RepoCursor> | null = null;
  const pages: Commit[][] = [];
  for (let guard = 0; guard < 100; guard++) {
    const ids: string[] = cursors ? [...cursors.keys()] : Object.keys(repos);
    const batches = ids.map((id) => {
      const cursor = cursors?.get(id);
      return { repoId: id, cursor, ...fakeGit(repos[id], pageSize, cursor) };
    });
    const r = mergeBatches(batches, seen);
    r.rows.forEach((c) => seen.add(commitKey(c)));
    pages.push(r.rows);
    cursors = r.cursors;
    if (cursors.size === 0) return pages;
  }
  throw new Error("paging did not terminate");
}
{
  const repos: Record<string, Commit[]> = {
    // A rebase: 450 commits sharing one committer second (> pageSize).
    rebased: Array.from({ length: 450 }, () => mk("rebased", 5000)),
    busy: Array.from({ length: 300 }, (_, i) => mk("busy", 6200 - i * 3)),
    empty: [],
    // Exhausted mid-merge: a short, old history that is cut on early pages.
    old: Array.from({ length: 5 }, (_, i) => mk("old", 100 + i)),
  };
  const pages = pageAll(repos, 200);
  const flat = pages.flat();
  const expected = Object.values(repos).flat().sort(compareCommits);
  assert.ok(pages.length >= 3, `expected several pages, got ${pages.length}`);
  assert.strictEqual(new Set(keys(flat)).size, flat.length, "no duplicates");
  assert.deepStrictEqual(keys(flat), keys(expected), "no gaps, and the global order holds across page boundaries");
  console.log("ok - paging a >pageSize same-second rebase terminates with no duplicates or gaps");
}
