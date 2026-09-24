import * as assert from "assert";
import type { NodeDesc } from "../changesModel";
import type { FileChange } from "../types";
import { contextFor, flatten, treeKey } from "./changesPaneModel";

const file = (path: string, status: FileChange["status"] = "M"): FileChange => ({ path, status, added: 1, deleted: 0 });
const f = (id: string, path: string): NodeDesc => ({ kind: "file", id, label: path.split("/").pop()!, description: "+1 −0", tooltip: path, path, file: file(path), openable: true });
const tree: NodeDesc[] = [{
  kind: "commit", id: "c", label: "feat: x", description: "abc1234 · rin · 1h ago", tooltip: "", children: [
    { kind: "folder", id: "c/d:src", label: "src", description: "2", tooltip: "src", path: "src", children: [f("c/f:src/a.ts", "src/a.ts"), f("c/f:src/b.ts", "src/b.ts")] },
    f("c/f:README.md", "README.md"),
  ],
}];

{
  const rows = flatten(tree, new Set());
  assert.deepStrictEqual(rows.map((r) => `${r.depth}:${r.node.label}`), ["0:feat: x", "1:src", "2:a.ts", "2:b.ts", "1:README.md"]);
  assert.deepStrictEqual(rows.map((r) => r.expanded), [true, true, undefined, undefined, undefined], "folders and the commit are expandable; files are not");
  assert.deepStrictEqual(flatten(tree, new Set(["c/d:src"])).map((r) => r.node.label), ["feat: x", "src", "README.md"], "a folded folder hides its files");
  assert.strictEqual(flatten(tree, new Set(["c/d:src"]))[1].expanded, false);
  console.log("ok - the drawn tree flattens depth-first, and folded folders hide their children");
}
{
  const rows = flatten(tree, new Set());
  assert.deepStrictEqual(treeKey("ArrowDown", rows, 0), { active: 1 });
  assert.deepStrictEqual(treeKey("ArrowUp", rows, 0), { active: 0 }, "stops at the top");
  assert.deepStrictEqual(treeKey("End", rows, 0), { active: 4 });
  assert.deepStrictEqual(treeKey("Home", rows, 3), { active: 0 });
  assert.deepStrictEqual(treeKey("ArrowLeft", rows, 1), { fold: "c/d:src" }, "← on an open folder folds it");
  assert.deepStrictEqual(treeKey("ArrowLeft", rows, 3), { active: 1 }, "← on a file goes to its folder");
  assert.deepStrictEqual(treeKey("ArrowRight", rows, 1), { active: 2 }, "→ on an open folder enters it");
  const folded = flatten(tree, new Set(["c/d:src"]));
  assert.deepStrictEqual(treeKey("ArrowRight", folded, 1), { unfold: "c/d:src" });
  assert.deepStrictEqual(treeKey("Enter", rows, 2), { open: "src/a.ts" });
  assert.deepStrictEqual(treeKey("Enter", rows, 1), { fold: "c/d:src" }, "Enter on a folder folds it, like a click");
  assert.strictEqual(treeKey("x", rows, 0), null);
  assert.deepStrictEqual(treeKey("ArrowDown", [], -1), null, "an empty tree ignores keys");
  console.log("ok - tree keys: arrows move, ←/→ fold and enter, Enter opens a file");
}
{
  assert.deepStrictEqual(JSON.parse(contextFor(tree[0])), { webviewSection: "commit", preventDefaultContextMenuItems: true });
  const fileNode = (tree[0] as { children: NodeDesc[] }).children[1];
  assert.deepStrictEqual(JSON.parse(contextFor(fileNode)), { webviewSection: "file", preventDefaultContextMenuItems: true, path: "README.md" });
  const folder = (tree[0] as { children: NodeDesc[] }).children[0];
  assert.deepStrictEqual(JSON.parse(contextFor(folder)), { webviewSection: "folder", preventDefaultContextMenuItems: true });
  console.log("ok - right-click context names the row, so VS Code shows the right native menu");
}
