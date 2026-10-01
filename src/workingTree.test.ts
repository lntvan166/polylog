import * as assert from "assert";
import { EMPTY_TREE, headOf, parseNumstat, splitStatus, stagedNumstatArgs, statusArgs, unstagedNumstatArgs, workFiles } from "./workingTree";

// git status --porcelain=v2 -z: "1 XY sub mH mI mW hH hI path", "2 XY … Xscore path\0orig", "? path", "u XY …".
const H = "0".repeat(40);
const rec = (xy: string, path: string) => `1 ${xy} N... 100644 100644 100644 ${H} ${H} ${path}`;

{
  const n = parseNumstat("3\t1\tsrc/app.ts\0-\t-\tlogo.png\0" + "2\t0\t\0docs/a.md\0docs/b.md\0");
  assert.deepStrictEqual(n.get("src/app.ts"), { added: 3, deleted: 1 });
  assert.deepStrictEqual(n.get("logo.png"), { added: null, deleted: null }, "binary");
  assert.deepStrictEqual(n.get("docs/b.md"), { added: 2, deleted: 0 }, "renames are keyed by the new name");
  console.log("ok - git diff --numstat -z gives each file's +/- counts");
}
{
  assert.deepStrictEqual(statusArgs([]), ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"], "--branch: the last commit comes in the same call");
  assert.deepStrictEqual(statusArgs([":(literal)src"]), ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--", ":(literal)src"], "the Path filter narrows it, after --");
  console.log("ok - status arguments");
}
{
  const withBranch = `# branch.oid ${"a".repeat(40)}\0# branch.head main\0` + rec(".M", "src/app.ts") + "\0";
  assert.strictEqual(headOf(withBranch), "a".repeat(40), "the last commit, from git status --branch");
  assert.strictEqual(headOf("# branch.oid (initial)\0# branch.head main\0"), null, "no commit yet");
  assert.deepStrictEqual(splitStatus(withBranch).changes.map((e) => e.path), ["src/app.ts"], "the # header lines are not files");
  console.log("ok - git status --branch gives the last commit too, so no separate rev-parse");
}
{
  const out = [
    rec(".M", "src/app.ts"), // changed, not staged
    rec("M.", "src/staged.ts"), // fully staged
    rec("MM", "src/both.ts"), // staged, then changed again
    rec("A.", "src/new.ts"), // added to the index
    rec("AM", "src/newer.ts"), // added, then changed again
    rec("AD", "added-then-deleted.ts"), // staged as new, then deleted from disk
    rec(".D", "old.txt"), // deleted in the working tree
    rec("D.", "gone.txt"), // git rm
    `2 R. N... 100644 100644 100644 ${H} ${H} R100 docs/b.md\0docs/a.md`,
    `2 RM N... 100644 100644 100644 ${H} ${H} R100 docs/d.md\0docs/c.md`,
    "? notes/todo café.md",
    `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict.ts`,
  ].join("\0") + "\0";
  const s = splitStatus(`# branch.oid ${"a".repeat(40)}\0# branch.head main\0` + out);
  assert.deepStrictEqual(s.staged.map((e) => [e.path, e.status]), [
    ["src/staged.ts", "M"], ["src/both.ts", "M"], ["src/new.ts", "A"], ["src/newer.ts", "A"], ["added-then-deleted.ts", "A"], ["gone.txt", "D"], ["docs/b.md", "R"], ["docs/d.md", "R"],
  ], "the index half: what a commit now would contain");
  assert.deepStrictEqual(s.changes.map((e) => [e.path, e.status]), [
    ["src/app.ts", "M"], ["src/both.ts", "M"], ["src/newer.ts", "M"], ["added-then-deleted.ts", "D"], ["old.txt", "D"], ["docs/d.md", "M"], ["notes/todo café.md", "A"], ["conflict.ts", "M"],
  ], "the working-tree half, untracked and conflicted files included");
  assert.strictEqual(s.staged.find((e) => e.path === "docs/b.md")?.oldPath, "docs/a.md");
  assert.ok(s.changes.find((e) => e.path === "notes/todo café.md")?.untracked);
  assert.ok(s.changes.find((e) => e.path === "conflict.ts")?.conflicted);
  assert.deepStrictEqual(splitStatus(""), { staged: [], changes: [] });
  console.log("ok - git status splits into Staged (index) and Changes (working tree); a file can be in both");
}
{
  assert.deepStrictEqual(stagedNumstatArgs("a".repeat(40), [":(literal)src"]), ["diff", "--cached", "a".repeat(40), "--numstat", "-z", "-M", "--", ":(literal)src"]);
  assert.deepStrictEqual(stagedNumstatArgs(null, []).slice(0, 3), ["diff", "--cached", EMPTY_TREE], "no commit yet: against the empty tree");
  assert.deepStrictEqual(unstagedNumstatArgs([]), ["diff", "--numstat", "-z", "--"], "index ↔ working tree");
  const files = workFiles(splitStatus(rec(".M", "a.ts") + "\0? b.ts\0").changes, parseNumstat("3\t1\ta.ts\0"));
  assert.deepStrictEqual(files.map((f) => [f.path, f.added, f.deleted, f.status, f.untracked === true]), [["a.ts", 3, 1, "M", false], ["b.ts", 0, 0, "A", true]], "an untracked file counts 0/0: new, not binary");
  console.log("ok - Staged and Changes counts come from their own diffs");
}
{
  const I = "c".repeat(40);
  const line = `1 MM N... 100644 100644 100644 ${"0".repeat(40)} ${I} src/both.ts`;
  const s = splitStatus(line + "\0" + `2 R. N... 100644 100644 100644 ${"0".repeat(40)} ${I} R100 docs/b.md\0docs/a.md\0`);
  assert.deepStrictEqual(s.staged.map((e) => [e.path, e.blob]), [["src/both.ts", I], ["docs/b.md", I]], "each staged entry knows its index blob (the hI field)");
  assert.strictEqual(workFiles(s.staged, new Map())[0].blob, I);
  console.log("ok - the staged side keeps its index blob id");
}
