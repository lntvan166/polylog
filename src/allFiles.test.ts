import * as assert from "assert";
import { Limiter, lsTreeArgs, mergeLevel, parseLsTree } from "./allFiles";
import type { FileChange } from "./types";

const H = "e".repeat(40);
{
  assert.deepStrictEqual(lsTreeArgs(H, ""), ["ls-tree", "-z", H, "--", "."]);
  assert.deepStrictEqual(lsTreeArgs(H, "src/checkout"), ["ls-tree", "-z", H, "--", "src/checkout/"]);
  const out = `040000 tree ${H}\tsrc\x00100644 blob ${H}\tREADME.md\x00160000 commit ${H}\tvendor/lib\x00100755 blob ${H}\tbin/run sh\x00`;
  assert.deepStrictEqual(parseLsTree(out), [{ path: "src", kind: "folder" }, { path: "README.md", kind: "file" }, { path: "vendor/lib", kind: "file", submodule: true }, { path: "bin/run sh", kind: "file" }], "folders, files, submodules as files, spaces kept");
  assert.deepStrictEqual(parseLsTree(""), []);
  console.log("ok - git ls-tree: one folder's entries");
}
{
  const listed = [{ path: "src/checkout/PaymentStep.tsx", kind: "file" as const }, { path: "src/checkout/Summary.tsx", kind: "file" as const }, { path: "src/checkout/SavedCards.tsx", kind: "file" as const }];
  const changed: FileChange[] = [
    { path: "src/checkout/PaymentStep.tsx", status: "M", added: 11, deleted: 1 },
    { path: "src/checkout/SavedCards.tsx", status: "A", added: 25, deleted: 0 },
    { path: "src/checkout/OldCards.tsx", status: "D", added: 0, deleted: 31 },
    { path: "src/client.ts", status: "M", added: 2, deleted: 0 },
  ];
  const level = mergeLevel("src/checkout", listed, changed);
  assert.deepStrictEqual(level.files.map((f) => [f.name, f.change?.status ?? ""]), [["OldCards.tsx", "D"], ["PaymentStep.tsx", "M"], ["SavedCards.tsx", "A"], ["Summary.tsx", ""]], "a deleted file is listed where it was; unchanged files plain");
  const top = mergeLevel("", [{ path: "src", kind: "folder" }, { path: "docs", kind: "folder" }, { path: "README.md", kind: "file" }], changed);
  assert.deepStrictEqual(top.folders.map((f) => [f.name, f.path, f.changedCount]), [["docs", "docs", 0], ["src", "src", 4]], "folders A→Z; changes counted inside, deleted included");
  assert.deepStrictEqual(top.files.map((f) => f.name), ["README.md"]);
  // A folder deleted entirely by the commit is no longer in its tree: it comes back, with its changes.
  const gone = mergeLevel("", [{ path: "README.md", kind: "file" }], [{ path: "old/a.ts", status: "D", added: 0, deleted: 3 }]);
  assert.deepStrictEqual(gone.folders.map((f) => [f.name, f.changedCount]), [["old", 1]]);
  console.log("ok - All Files: one folder's listing merged with the commit's changes");
}
{
  // All Files: folder reads run a few at a time, and one folder is read once even when asked twice.
  (async () => {
    const lim = new Limiter(2);
    let running = 0, most = 0, calls = 0;
    const job = (k: string) => lim.run(k, async () => {
      calls++; running++; most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return k;
    });
    const out = await Promise.all(["a", "b", "c", "d", "a", "b"].map(job));
    assert.deepStrictEqual(out, ["a", "b", "c", "d", "a", "b"]);
    assert.strictEqual(most, 2, "never more than the limit at once");
    assert.strictEqual(calls, 4, "a folder asked for twice while its read runs is read once");
    console.log("ok - All Files reads folders a few at a time, each once");
  })().catch((e) => { console.error(e); process.exit(1); });
}

// A submodule (gitlink) is listed as a file, marked: it has no text to open.
assert.deepStrictEqual(parseLsTree("160000 commit " + "a".repeat(40) + "\tvendor/lib\x00100644 blob " + "b".repeat(40) + "\tREADME.md\x00"), [
  { path: "vendor/lib", kind: "file", submodule: true },
  { path: "README.md", kind: "file" },
]);
console.log("ok - a submodule is listed as a file, marked so it is not opened as text");
