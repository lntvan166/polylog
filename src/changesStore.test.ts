import * as assert from "assert";
import { ChangesStore } from "./changesStore";
import type { Commit } from "./types";

const commit: Commit = { repoId: "/ws/acme-api", sha: "a".repeat(40), parents: ["b".repeat(40)], author: "rin", email: "rin@example.com", time: 1000, subject: "feat: retry" };
const base = { commit, repoRoot: "/ws/acme-api", repoName: "acme-api" };

{
  const store = new ChangesStore();
  let fired = 0;
  store.onDidChange(() => fired++);
  assert.deepStrictEqual(store.snapshot(), { message: "Select a commit in the Log to see its changed files.", items: [], decorations: [], focused: undefined });
  store.set({ ...base, status: "ready", message: "feat: retry\n\nWhy: flaky uploads.", files: [{ path: "src/upload.go", added: 2, deleted: 0, status: "M" }], focusPath: "src/upload.go" });
  assert.strictEqual(fired, 1, "listeners hear every change");
  const s = store.snapshot();
  assert.strictEqual(s.message, undefined);
  assert.match(s.items[0], /^feat: retry \| aaaaaaa · rin · /);
  assert.deepStrictEqual(s.items.slice(1), ["  src | 1", "    upload.go | +2 −0"]);
  assert.deepStrictEqual(s.decorations, ["upload.go M gitDecoration.modifiedResourceForeground"]);
  assert.strictEqual(s.focused, "upload.go");
  console.log("ok - the store describes the commit for the webview and the test seam");
}
{
  const store = new ChangesStore();
  store.set({ ...base, status: "ready", message: "feat: retry\n\nWhy: flaky uploads.", files: [], focusPath: undefined });
  const v = store.view(2000);
  assert.strictEqual(v.body, "Why: flaky uploads.", "the message body under the subject is shown in the pane");
  assert.strictEqual(v.message, "This commit changes no files.");
  store.set({ ...base, status: "ready", message: "feat: retry", files: [] });
  assert.strictEqual(store.view(2000).body, "", "a subject-only message has no body");
  console.log("ok - the pane gets the commit message body, not the subject twice");
}
{
  const store = new ChangesStore();
  store.set({ ...base, status: "ready", message: "", files: [{ path: "a.ts", added: 1, deleted: 1, status: "M" }, { path: "logo.png", added: null, deleted: null, status: "A" }] });
  assert.deepStrictEqual(store.openable("a.ts"), { repoId: "/ws/acme-api", sha: "a".repeat(40), parent: "b".repeat(40), path: "a.ts", oldPath: undefined });
  assert.strictEqual(store.openable("logo.png"), undefined, "binary files have no text diff");
  assert.strictEqual(store.openable("../etc/passwd"), undefined, "a path from the webview must be one of this commit's files");
  store.set({ ...base, status: "loading", message: "", files: [] });
  assert.strictEqual(store.openable("a.ts"), undefined, "nothing opens while the commit is loading");
  console.log("ok - a file the webview asks to open must belong to the commit on screen");
}
