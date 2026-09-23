import * as assert from "assert";
import { LOG_FORMAT, parseLog } from "./gitLog";
import { commitKey, isSha } from "./types";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const REPO = "/ws/acme-api";
// One record exactly as git emits it: NUL between fields, RS after the last.
const rec = (sha: string, ct: number, an: string, subject: string, parents: string) =>
  [sha, String(ct), an, `${an}@example.com`, subject, parents].join("\0") + "\x1e";

// ── The format string is the contract the parser relies on ─────────────────
{
  assert.strictEqual(LOG_FORMAT, "--format=%H%x00%ct%x00%an%x00%ae%x00%s%x00%P%x1e");
  console.log("ok - LOG_FORMAT is NUL-delimited fields, RS-terminated records");
}

// ── Records become commits; git's newline between records is tolerated ─────
{
  const out = rec(A, 1758600300, "rin", "feat: add retry to uploader", B) + "\n" +
    rec(B, 1758600000, "dana", "feat: scaffold api", "") + "\n";
  assert.deepStrictEqual(parseLog(out, REPO), [
    { repoId: REPO, sha: A, time: 1758600300, author: "rin", email: "rin@example.com", subject: "feat: add retry to uploader", parents: [B] },
    { repoId: REPO, sha: B, time: 1758600000, author: "dana", email: "dana@example.com", subject: "feat: scaffold api", parents: [] },
  ]);
  console.log("ok - parses records; a root commit has no parents");
}

// ── A merge carries both parents ────────────────────────────────────────────
{
  const [merge] = parseLog(rec(A, 1, "dana", "merge origin/release-1.4", `${B} ${C}`), REPO);
  assert.deepStrictEqual(merge.parents, [B, C]);
  console.log("ok - a merge commit carries every parent");
}

// ── Subjects never need escaping ────────────────────────────────────────────
{
  const subjects = [`say "hi" and 'bye'`, "café ✓ 🚀 日本語", "tab\there back\\slash", "looks like %x00 and , ; |"];
  const out = subjects.map((s, i) => rec(String(i).repeat(40), 100 - i, "rin", s, "")).join("\n");
  assert.deepStrictEqual(parseLog(out, REPO).map((c) => c.subject), subjects);
  console.log("ok - quotes, unicode, emoji, tabs and backslashes round-trip");
}

// ── Empty output is an empty history, not an error ──────────────────────────
{
  assert.deepStrictEqual(parseLog("", REPO), []);
  assert.deepStrictEqual(parseLog("\n", REPO), []);
  console.log("ok - empty output parses to no commits");
}

// ── A record cut off by a killed process is dropped, earlier ones kept ─────
{
  const out = rec(A, 5, "dana", "complete", "") + "\n" + [B, "17586", "da"].join("\0");
  assert.deepStrictEqual(parseLog(out, REPO).map((c) => c.sha), [A]);
  console.log("ok - a truncated final record is dropped");
}

// ── Malformed records are skipped, SHA-256 repositories accepted ───────────
{
  const bad = ["x".repeat(40), "1", "a", "b", "c", ""].join("\0") + "\x1e"; // not hex
  const noTime = [A, "soon", "a", "b", "c", ""].join("\0") + "\x1e";
  const tooFew = [A, "1", "a"].join("\0") + "\x1e";
  const sha256 = "d".repeat(64);
  const out = bad + noTime + tooFew + rec(sha256, 9, "rin", "sha256 repo", "");
  assert.deepStrictEqual(parseLog(out, REPO).map((c) => c.sha), [sha256]);
  console.log("ok - malformed records are skipped; 64-hex SHAs are accepted");
}

// ── Helpers ─────────────────────────────────────────────────────────────────
{
  assert.notStrictEqual(commitKey({ repoId: "/a", sha: A }), commitKey({ repoId: "/b", sha: A }));
  assert.ok(isSha(A) && isSha("d".repeat(64)));
  assert.ok(!isSha("--output=/tmp/x") && !isSha(A.toUpperCase()) && !isSha("a".repeat(39)) && !isSha(undefined));
  console.log("ok - commitKey separates repos; isSha accepts only 40/64 lowercase hex");
}
