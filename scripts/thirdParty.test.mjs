// ThirdPartyNotices.txt names the exact versions bundled into out/webview.js. A lockfile
// refresh can move Lit (a caret dependency of @vscode-elements/elements) silently: fail
// when the notices and package-lock.json disagree, so the notices are regenerated.
import assert from "node:assert";
import { readFileSync } from "node:fs";

const notices = readFileSync(new URL("../ThirdPartyNotices.txt", import.meta.url), "utf8");
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const listed = [...notices.matchAll(/^(@?[\w./-]+) (\d[\w.+-]*) \(/gm)].map((m) => ({ name: m[1], version: m[2] }));
assert.ok(listed.length >= 5, "the notices list every bundled package");
for (const { name, version } of listed) {
  const locked = lock.packages[`node_modules/${name}`]?.version;
  assert.strictEqual(version, locked, `ThirdPartyNotices.txt says ${name} ${version}, package-lock.json has ${locked}`);
}
console.log("ok - ThirdPartyNotices.txt matches the bundled versions in package-lock.json");
