import * as assert from "assert";
import { fileTree } from "./fileTree";

{
  const f = (path: string) => ({ path, added: 1, deleted: 0 });
  const tree = fileTree([f("src/client.ts"), f("internal/upload/upload_test.go"), f("README.md"), f("internal/upload/upload.go")]);
  const shape = (nodes: ReturnType<typeof fileTree>): unknown => nodes.map((n) => n.kind === "folder" ? [n.name, n.count, shape(n.children)] : n.name);
  assert.deepStrictEqual(shape(tree), [["internal/upload", 2, ["upload.go", "upload_test.go"]], ["src", 1, ["client.ts"]], "README.md"]);
  assert.deepStrictEqual(shape(fileTree([f("a/b/x.ts"), f("a/c/y.ts")])), [["a", 2, [["b", 1, ["x.ts"]], ["c", 1, ["y.ts"]]]]]);
  assert.deepStrictEqual(fileTree([]), []);
  console.log("ok - fileTree groups by folder, folders first, single-child chains compressed");
}
