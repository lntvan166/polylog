import * as assert from "assert";
import { diffSides, parseNumstat, showArgs } from "./commitDetail";

const SHA = "a".repeat(40);
const PARENT = "b".repeat(40);
const OTHER = "c".repeat(40);

{
  assert.deepStrictEqual(showArgs(SHA), ["show", "--numstat", "-z", "-M", "--diff-merges=first-parent", "--format=", SHA]);
  console.log("ok - showArgs: NUL-separated numstat, renames, first-parent for merges");
}

// Byte-exact shapes captured from git 2.43 (see plan Task 5 notes).
{
  const root = "-\t-\tbin.dat\x001\t0\tsp ace é.txt\x00";
  assert.deepStrictEqual(parseNumstat(root), [
    { path: "bin.dat", added: null, deleted: null },
    { path: "sp ace é.txt", added: 1, deleted: 0 },
  ]);
  console.log("ok - binary files have null counts; unicode and spaces are unquoted with -z");
}

{
  const rename = "0\t0\t\x00sp ace é.txt\x00renamed.txt\x00";
  assert.deepStrictEqual(parseNumstat(rename), [{ path: "renamed.txt", oldPath: "sp ace é.txt", added: 0, deleted: 0 }]);
  console.log("ok - a rename carries oldPath");
}

{
  const odd = "3\t1\tweird\tname\nx.txt\x00\n12\t40\tsrc/client.ts\x00";
  assert.deepStrictEqual(parseNumstat(odd), [
    { path: "weird\tname\nx.txt", added: 3, deleted: 1 },
    { path: "src/client.ts", added: 12, deleted: 40 },
  ]);
  console.log("ok - paths containing tabs or newlines survive; a stray leading newline is ignored");
}

{
  assert.deepStrictEqual(parseNumstat(""), []);
  assert.deepStrictEqual(parseNumstat("0\t0\t\x00only-old.txt\x00"), [], "a rename cut off before its new path is dropped");
  console.log("ok - empty and truncated output");
}

{
  const root = "/ws/acme-api";
  assert.deepStrictEqual(diffSides(root, { sha: SHA, parents: [PARENT] }, { path: "a.go" }), {
    before: { root, ref: PARENT, path: "a.go" },
    after: { root, ref: SHA, path: "a.go" },
  });
  assert.strictEqual(diffSides(root, { sha: SHA, parents: [] }, { path: "a.go" }).before.ref, null, "root commit: empty before side");
  assert.strictEqual(diffSides(root, { sha: SHA, parents: [PARENT] }, { path: "new.go", oldPath: "old.go" }).before.path, "old.go");
  assert.strictEqual(diffSides(root, { sha: SHA, parents: [PARENT, OTHER] }, { path: "a.go" }).before.ref, PARENT, "merge: first parent");
  console.log("ok - diffSides: parent vs commit, empty root side, rename source, first parent of merges");
}
