import * as assert from "assert";
import {
  bothPaths, COMMIT_PAGE, filesArgs, logArgs, mergeBaseArgs, mirror, pairDuplicates, parseFiles, parseRevParse,
  parseSideCount, parseSideLog, pickerGroups, pushRecent, revParseArgs, sideCountArgs, summaryLabel, tabTitle, validPair,
  type RepoCompare,
} from "./compareModel";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

// Branch names from the webview: only refs git would accept as a branch name.
assert.ok(validPair({ left: "origin/release-1.4", right: "main" }));
for (const bad of ["-x", "a..b", "HEAD~3", "", "x y", "re^{commit}"]) assert.ok(!validPair({ left: bad, right: "main" }), bad);
assert.ok(!validPair({ left: "main" }));
assert.ok(!validPair(null));
console.log("ok - a pair is two names git accepts as branches");

assert.deepStrictEqual(revParseArgs({ left: "origin/release-1.4", right: "main" }), ["rev-parse", "origin/release-1.4^{commit}", "main^{commit}"]);
assert.deepStrictEqual(parseRevParse(`${A}\n${B}\n`), [A, B]);
assert.strictEqual(parseRevParse(`${A}\n`), null);
assert.strictEqual(parseRevParse("nope\nzz\n"), null);
console.log("ok - both branches resolve to commit ids, or the repository lacks one");

assert.deepStrictEqual(mergeBaseArgs(A, B), ["merge-base", A, B]);
assert.deepStrictEqual(sideCountArgs("left", A, B), ["rev-list", "--left-only", "--cherry-mark", "--count", `${A}...${B}`]);
assert.deepStrictEqual(sideCountArgs("right", A, B), ["rev-list", "--right-only", "--cherry-mark", "--count", `${A}...${B}`]);
assert.deepStrictEqual(parseSideCount("2\t1\n"), { only: 2, same: 1 });
assert.deepStrictEqual(parseSideCount("3\n"), { only: 3, same: 0 });
assert.deepStrictEqual(parseSideCount(""), { only: 0, same: 0 });
console.log("ok - each side counts its own commits and its duplicates");

assert.deepStrictEqual(filesArgs(C, A), ["diff", "--raw", "--numstat", "-z", "-M", C, A]);
// --raw records, then --numstat records; a rename carries both names.
const raw = [
  ":000000 100644 0000000 1111111 A", "src/limit.go",
  ":100644 100644 2222222 3333333 R090", "src/old.go", "src/new.go",
  ":100644 100644 4444444 5555555 M", "bin.png",
  "40\t0\tsrc/limit.go", "1\t1\t", "src/old.go", "src/new.go", "-\t-\tbin.png", "",
].join("\0");
const files = parseFiles(raw);
assert.deepStrictEqual(files.map((f) => [f.path, f.oldPath, f.status, f.added, f.deleted]), [
  ["src/limit.go", undefined, "A", 40, 0],
  ["src/new.go", "src/old.go", "R", 1, 1],
  ["bin.png", undefined, "M", null, null],
]);
console.log("ok - Files reads each changed file with its status, rename and counts");

const other = parseFiles(["1\t1\tsrc/new.go", "2\t0\tREADME.md", ""].join("\0"));
assert.deepStrictEqual([...bothPaths(files, other)], ["src/new.go"]);
console.log("ok - a file changed on both sides is matched on its new path");

assert.deepStrictEqual(logArgs("left", A, B, COMMIT_PAGE), [
  "log", "--left-only", "--cherry-mark", "--max-count=500", "--format=%m%x1f%H%x1f%P%x1f%ct%x1f%aN%x1f%s%x1e", `${A}...${B}`,
]);
const log = parseSideLog(`<\x1f${A}\x1f${C}\x1f1758000300\x1fdana\x1ffeat: rate limit\x1e\n=\x1f${B}\x1f${C} ${A}\x1f1758000200\x1frin\x1ffix: retry on 503\x1e\n`);
assert.deepStrictEqual(log, [
  { mark: "+", sha: A, parents: [C], time: 1758000300, author: "dana", subject: "feat: rate limit" },
  { mark: "=", sha: B, parents: [C, A], time: 1758000200, author: "rin", subject: "fix: retry on 503" },
]);
console.log("ok - a side's log marks its duplicates");

const dl = [{ mark: "=" as const, sha: A, parents: [], time: 2, author: "dana", subject: "fix: retry on 503" }, { mark: "=" as const, sha: C, parents: [], time: 1, author: "dana", subject: "fix: squash" }];
const dr = [{ mark: "=" as const, sha: B, parents: [], time: 3, author: "rin", subject: "fix: retry on 503" }];
assert.deepStrictEqual(pairDuplicates(dl, dr), [
  { subject: "fix: retry on 503", left: A, right: B },
  { subject: "fix: squash", left: C },
]);
console.log("ok - duplicates pair up by subject, the rest stay on their side");

const differs: RepoCompare = { kind: "differs", leftSha: A, rightSha: B, base: C, left: 2, right: 1, sameLeft: 1, sameRight: 1 };
assert.deepStrictEqual(mirror(differs), { kind: "differs", leftSha: B, rightSha: A, base: C, left: 1, right: 2, sameLeft: 1, sameRight: 1 });
assert.deepStrictEqual(mirror({ kind: "missing" }), { kind: "missing" });
console.log("ok - swap mirrors a result without reading git");

const results: RepoCompare[] = [differs, { ...differs, left: 5, right: 0, sameLeft: 0, sameRight: 0 }, { kind: "identical" }, { kind: "missing" }, { kind: "missing" }, { kind: "nobase" }];
assert.strictEqual(summaryLabel(results, 6), "3 repositories differ · ◀7 ▶1 =1 · 1 identical · 2 missing a branch · in 6 repositories");
assert.strictEqual(summaryLabel([{ kind: "identical" }], 1), "0 repositories differ · ◀0 ▶0 =0 · 1 identical · in 1 repository");
console.log("ok - the summary counts what differs, what is identical and what is missing");

assert.strictEqual(tabTitle({ left: "origin/release-1.4", right: "origin/main" }), "⇄ release-1.4 ↔ main");
assert.strictEqual(tabTitle(null), "⇄ Compare Branches");
console.log("ok - the tab is named after the pair");

const p1 = { left: "origin/release-1.4", right: "origin/main" };
const p2 = { left: "origin/release-1.3", right: "origin/prod" };
let recent = pushRecent([], p1);
recent = pushRecent(recent, p2);
recent = pushRecent(recent, p1);
assert.deepStrictEqual(recent, [p1, p2]);
for (let i = 0; i < 9; i++) recent = pushRecent(recent, { left: `rel-${i}`, right: "main" });
assert.strictEqual(recent.length, 5);
console.log("ok - recent pairs: newest first, once each, at most five");

const names = [{ name: "origin/main", count: 68 }, { name: "main", count: 68 }, { name: "origin/release-1.4", count: 56 }, { name: "feat/billing", count: 3 }];
const groups = pickerGroups(names, ["origin/main"], [p1], "");
assert.deepStrictEqual(groups.map((g) => [g.title, g.items.length]), [["Recent pairs", 1], ["Favorites", 1], ["Local", 2], ["Remote", 2]]);
const searched = pickerGroups(names, ["origin/main"], [p1], "REL");
assert.deepStrictEqual(searched.map((g) => g.title), ["Remote"]);
assert.deepStrictEqual(pickerGroups(names, [], [], "zzz"), []);
console.log("ok - the Branch picker groups names and filters them as you type");
