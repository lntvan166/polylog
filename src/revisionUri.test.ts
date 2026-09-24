import * as assert from "assert";
import { decodeRevision, encodeRevision, SCHEME, type RevisionRef } from "./revisionUri";

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
