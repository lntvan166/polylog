import * as assert from "assert";
import { agoText, blameArgs, blameAt, formatBlame, parseBlame } from "./blameModel";

const A = "a".repeat(40);
const B = "b".repeat(40);

// `git blame --incremental`: a commit's details come once, the first time it appears.
const OUT = [
  `${A} 1 1 2`,
  "author dana",
  "author-mail <dana@example.com>",
  "author-time 1000",
  "author-tz +0000",
  "committer dana",
  "committer-mail <dana@example.com>",
  "committer-time 1000",
  "committer-tz +0000",
  "summary feat: upload limits",
  "filename src/upload.ts",
  `${B} 3 3 1`,
  "author rin",
  "author-mail <rin@example.com>",
  "author-time 2000",
  "author-tz +0700",
  "summary fix: retry, then give up",
  `previous ${A} src/upload.ts`,
  "filename src/upload.ts",
  `${A} 4 4 1`,
  "filename src/upload.ts",
  "",
].join("\n");

{
  assert.deepStrictEqual(blameArgs(A, "src/upload.ts"), ["-c", "i18n.logOutputEncoding=UTF-8", "blame", "--root", "--incremental", A, "--", "src/upload.ts"]);
  console.log("ok - blameArgs pins the commit and ends options before the path");
}

{
  const b = parseBlame(OUT);
  assert.strictEqual(blameAt(b, 1)?.hash, A);
  assert.strictEqual(blameAt(b, 2)?.authorName, "dana");
  assert.strictEqual(blameAt(b, 3)?.authorName, "rin");
  assert.strictEqual(blameAt(b, 3)?.subject, "fix: retry, then give up");
  assert.strictEqual(blameAt(b, 4)?.hash, A, "a later range of a commit seen earlier keeps its details");
  assert.strictEqual(blameAt(b, 4)?.authorEmail, "dana@example.com");
  assert.strictEqual(blameAt(b, 5), undefined);
  assert.strictEqual(blameAt(parseBlame(""), 1), undefined);
  console.log("ok - parseBlame maps each line to its commit, details shared across ranges");
}

{
  const now = 10 * 86400;
  assert.strictEqual(agoText(now - 5, now), "just now");
  assert.strictEqual(agoText(now - 120, now), "2 minutes ago");
  assert.strictEqual(agoText(now - 3600, now), "1 hour ago");
  assert.strictEqual(agoText(now - 3 * 86400, now), "3 days ago");
  assert.strictEqual(agoText(now - 60 * 86400, now + 300 * 86400), "12 months ago");
  assert.strictEqual(agoText(0, 800 * 86400), "2 years ago");
  console.log("ok - agoText reads like VS Code's relative dates");
}

{
  const info = blameAt(parseBlame(OUT), 3)!;
  const now = 2000 + 2 * 86400;
  assert.strictEqual(formatBlame("${subject}, ${authorName} (${authorDateAgo})", info, now), "fix: retry, then give up, rin (2 days ago)");
  assert.strictEqual(formatBlame("${hashShort} ${authorEmail} ${nope}", info, now), "bbbbbbb rin@example.com ${nope}");
  const long = { ...info, subject: "x".repeat(80) };
  assert.strictEqual(formatBlame("${subject}", long, now), `${"x".repeat(49)}…`, "long subjects are cut like VS Code's");
  console.log("ok - formatBlame fills VS Code's template variables and leaves unknown ones");
}
