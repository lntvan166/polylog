import * as assert from "assert";
import { EMPTY_TREE, numstatArgs, parseNumstat, parseStatus, statusArgs, uncommittedFiles } from "./workingTree";

// git status --porcelain=v2 -z: "1 XY sub mH mI mW hH hI path", "2 XY … Xscore path\0orig", "? path", "u XY …".
const H = "0".repeat(40);
const rec = (xy: string, path: string) => `1 ${xy} N... 100644 100644 100644 ${H} ${H} ${path}`;
const status = [
  rec(".M", "src/app.ts"), // changed, not staged
  rec("M.", "src/staged.ts"), // changed and fully staged
  rec("MM", "src/both.ts"), // staged, then changed again
  rec("A.", "src/new.ts"), // added to the index
  rec(".D", "old.txt"), // deleted in the working tree
  rec("D.", "gone.txt"), // git rm
  `2 R. N... 100644 100644 100644 ${H} ${H} R100 docs/b.md\0docs/a.md`, // git mv
  "? notes/todo café.md", // untracked, with a space and unicode
  `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict.ts`,
  rec("AD", "added-then-deleted.ts"), // nothing left against HEAD
].join("\0") + "\0";

{
  const s = parseStatus(status);
  assert.deepStrictEqual(s.map((e) => [e.path, e.status, e.staged]), [
    ["src/app.ts", "M", false],
    ["src/staged.ts", "M", true],
    ["src/both.ts", "M", false],
    ["src/new.ts", "A", true],
    ["old.txt", "D", false],
    ["gone.txt", "D", true],
    ["docs/b.md", "R", true],
    ["notes/todo café.md", "A", false],
    ["conflict.ts", "M", false],
  ], "each entry's change against the last commit, and whether it is fully staged");
  assert.strictEqual(s.find((e) => e.path === "docs/b.md")?.oldPath, "docs/a.md", "a rename keeps its old name");
  assert.ok(s.find((e) => e.path === "notes/todo café.md")?.untracked, "untracked files are marked");
  assert.ok(s.find((e) => e.path === "conflict.ts")?.conflicted, "merge conflicts are marked");
  assert.deepStrictEqual(parseStatus(""), [], "a clean tree");
  console.log("ok - git status --porcelain=v2 -z becomes changes against the last commit");
}
{
  const n = parseNumstat("3\t1\tsrc/app.ts\0-\t-\tlogo.png\0" + "2\t0\t\0docs/a.md\0docs/b.md\0");
  assert.deepStrictEqual(n.get("src/app.ts"), { added: 3, deleted: 1 });
  assert.deepStrictEqual(n.get("logo.png"), { added: null, deleted: null }, "binary");
  assert.deepStrictEqual(n.get("docs/b.md"), { added: 2, deleted: 0 }, "renames are keyed by the new name");
  console.log("ok - git diff --numstat -z gives each file's +/- counts");
}
{
  const files = uncommittedFiles(parseStatus(status), parseNumstat("3\t1\tsrc/app.ts\0"));
  const app = files.find((f) => f.path === "src/app.ts")!;
  assert.deepStrictEqual([app.added, app.deleted, app.status, app.staged], [3, 1, "M", false]);
  const todo = files.find((f) => f.path === "notes/todo café.md")!;
  assert.deepStrictEqual([todo.status, todo.untracked, todo.added !== null], ["A", true, true], "an untracked file opens as new (not as binary)");
  console.log("ok - status and counts combine into the Changes tree's file list");
}
{
  assert.deepStrictEqual(statusArgs([]), ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
  assert.deepStrictEqual(statusArgs([":(literal)src"]), ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", ":(literal)src"], "the Path filter narrows it, after --");
  assert.deepStrictEqual(numstatArgs("a".repeat(40), []), ["diff", "a".repeat(40), "--numstat", "-z", "-M", "--"]);
  assert.deepStrictEqual(numstatArgs(null, []).slice(0, 2), ["diff", EMPTY_TREE], "a repository with no commit yet compares with the empty tree");
  console.log("ok - status and numstat arguments");
}
