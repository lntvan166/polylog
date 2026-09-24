import * as assert from "assert";
import { compareCommits, takeReady, type RepoProgress } from "./mergeStream";
import { commitKey, type Commit } from "./types";

let serial = 0;
const mk = (repoId: string, time: number): Commit => ({
  repoId, time, sha: (++serial).toString(16).padStart(40, "0"),
  author: "dana", email: "dana@example.com", subject: `${repoId}@${time}`, parents: [],
});
const prog = (pending: Commit[], exhausted: boolean): RepoProgress => ({ fetched: pending.length, pending, exhausted });

// ── Ordering: newest first across repos; exhausted repos flush completely ──
{
  const p = new Map([["web", prog([mk("web", 50), mk("web", 10)], true)], ["api", prog([mk("api", 40), mk("api", 20)], true)]]);
  assert.deepStrictEqual(takeReady(p).map((c) => c.time), [50, 40, 20, 10]);
  assert.ok([...p.values()].every((x) => x.pending.length === 0));
  console.log("ok - merges repos newest first; exhausted repos hold nothing back");
}

// ── Equal timestamps: stable tie-break on SHA ───────────────────────────────
{
  const a = { ...mk("web", 7), sha: "f".repeat(40) };
  const b = { ...mk("api", 7), sha: "0".repeat(40) };
  const rows = takeReady(new Map([["web", prog([a], true)], ["api", prog([b], true)]]));
  assert.deepStrictEqual(rows.map((c) => c.sha), [b.sha, a.sha]);
  assert.ok(compareCommits(b, a) < 0);
  console.log("ok - equal timestamps are ordered by SHA");
}

// ── Empty input ─────────────────────────────────────────────────────────────
{
  assert.deepStrictEqual(takeReady(new Map()), []);
  assert.deepStrictEqual(takeReady(new Map([["web", prog([], true)]])), []);
  console.log("ok - nothing pending yields nothing");
}

// ── Horizon: rows older than a repo that may have more are held back ───────
{
  const web = prog([mk("web", 900), mk("web", 500)], false);
  const api = prog([mk("api", 800), mk("api", 400)], true);
  const rows = takeReady(new Map([["web", web], ["api", api]]));
  assert.deepStrictEqual(rows.map((c) => c.time), [900, 800, 500]);
  assert.deepStrictEqual(api.pending.map((c) => c.time), [400], "held back for a later page, not dropped");
  assert.deepStrictEqual(web.pending, []);
  console.log("ok - rows older than the horizon stay pending");
}

// ── A backwards-dated commit sinks to its date instead of setting the pace ─
{
  const skewed = prog([mk("web", 100), mk("web", 1)], false); // walk order: child with an old clock
  const busy = prog([mk("api", 90), mk("api", 80)], false);
  const rows = takeReady(new Map([["web", skewed], ["api", busy]]));
  assert.deepStrictEqual(rows.map((c) => c.time), [100, 90, 80]);
  assert.deepStrictEqual(skewed.pending.map((c) => c.time), [1]);
  console.log("ok - a skewed commit waits in pending; nothing is lost");
}

{
  assert.ok(commitKey(mk("a", 1)) !== commitKey(mk("b", 1)));
}
