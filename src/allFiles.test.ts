import * as assert from "assert";
import { lsTreeArgs, mergeLevel, parseLsTree } from "./allFiles";
import type { FileChange } from "./types";

const H = "e".repeat(40);
{
  assert.deepStrictEqual(lsTreeArgs(H, ""), ["ls-tree", "-z", H, "--", "."]);
  assert.deepStrictEqual(lsTreeArgs(H, "src/checkout"), ["ls-tree", "-z", H, "--", "src/checkout/"]);
  const out = `040000 tree ${H}\tsrc\x00100644 blob ${H}\tREADME.md\x00160000 commit ${H}\tvendor/lib\x00100755 blob ${H}\tbin/run sh\x00`;
  assert.deepStrictEqual(parseLsTree(out), [{ path: "src", kind: "folder" }, { path: "README.md", kind: "file" }, { path: "vendor/lib", kind: "file" }, { path: "bin/run sh", kind: "file" }], "folders, files, submodules as files, spaces kept");
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
