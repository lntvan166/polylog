import assert from "node:assert";
import { findHits, parsePatterns } from "./denylist.mjs";

// "foocorp" / "bar-svc" are stand-ins; real entries never appear in this repo.
{
  assert.deepStrictEqual(
    parsePatterns("# comment, not an entry\nFooCorp\n  bar-svc , baz\n\n"),
    ["foocorp", "bar-svc", "baz"],
  );
  assert.deepStrictEqual(parsePatterns(""), []);
  assert.deepStrictEqual(parsePatterns("  \n# only comments\n"), []);
  console.log("ok - parsePatterns splits on newlines and commas, lowercases, drops comments");
}

{
  const hits = findHits("clean line\nimport FOOCORP/internal/x\nalso bar-svc here\n", ["foocorp", "bar-svc"]);
  assert.deepStrictEqual(hits, [{ line: 2, entry: 1 }, { line: 3, entry: 2 }]);
  console.log("ok - findHits is a case-insensitive substring match with 1-based lines");
}

{
  const hits = findHits("x foocorp y", ["foocorp"]);
  assert.ok(!JSON.stringify(hits).includes("foocorp"), "a hit reports the entry index, never the word");
  console.log("ok - hits never contain the denylisted word (CI logs are public)");
}

{
  assert.deepStrictEqual(findHits("anything", []), []);
  console.log("ok - no patterns, no hits");
}
