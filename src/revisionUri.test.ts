import * as assert from "assert";
import * as nodePath from "path";
import { decodeRevision, encodeRevision, SCHEME, workingFile, type RevisionRef } from "./revisionUri";

const SHA = "a".repeat(40);

{
  assert.strictEqual(SCHEME, "polylog");
  for (const r of [
    { root: "/ws/acme-api", ref: SHA, path: "internal/upload/upload.go" },
    { root: "C:\\src\\acme-web", ref: null, path: "sp ace é.txt" },
  ] satisfies RevisionRef[]) {
    const { path, query } = encodeRevision(r);
    assert.ok(path.startsWith("/"), "leading slash keeps the file extension for language detection");
    assert.deepStrictEqual(decodeRevision(path, query), r);
  }
  console.log("ok - revision refs round-trip, including spaces, unicode and null refs");
}

{
  const bad = (q: string) => assert.throws(() => decodeRevision("/x", q), /not a polylog revision/);
  bad(JSON.stringify({ root: "/ws/acme-api", ref: "--output=/tmp/x" }));
  bad(JSON.stringify({ root: "/ws/acme-api", ref: "HEAD" }));
  bad(JSON.stringify({ ref: SHA }));
  bad("{not json");
  console.log("ok - decodeRevision rejects non-SHA refs (option injection) and malformed queries");
}
{
  // Built with path.resolve so the test holds on Windows (D:\\ws\\…) as well as POSIX.
  const root = nodePath.resolve("/ws/acme-web");
  const ref = { root, ref: SHA };
  assert.strictEqual(workingFile({ ...ref, path: "src/checkout/PaymentStep.tsx" }, [root]), nodePath.join(root, "src", "checkout", "PaymentStep.tsx"));
  assert.strictEqual(workingFile({ ...ref, path: "../../etc/passwd" }, [root]), undefined, "never leaves the repository");
  assert.strictEqual(workingFile({ ...ref, path: "a/../../b" }, [root]), undefined);
  assert.strictEqual(workingFile({ ...ref, path: "" }, [root]), undefined);
  assert.strictEqual(workingFile({ ...ref, path: "..notes.md" }, [root]), nodePath.join(root, "..notes.md"), "a file whose name starts with .. is still inside");
  assert.strictEqual(workingFile({ ...ref, path: "a.ts" }, [nodePath.resolve("/ws/acme-api")]), undefined, "only a repository of this workspace");
  console.log("ok - Open File maps a revision to its working-tree file, inside a workspace repository only");
}
