import * as assert from "assert";
import { decorationFor, describeChanges, firstOpenable, LOADING, NO_FILES, NO_SELECTION, type ChangesState, type NodeDesc } from "./changesModel";
import type { Commit } from "./types";

const NOW = 1790164800;
const commit: Commit = {
  repoId: "/ws/acme-api", sha: "1596c39".padEnd(40, "0"), time: NOW - 2 * 3600, author: "rin", email: "rin@example.com",
  subject: "feat: add retry to uploader (ACME-7)", parents: ["b".repeat(40)],
};
const state = (over: Partial<ChangesState> = {}): ChangesState => ({
  commit, repoRoot: "/ws/acme-api", repoName: "acme-api", status: "ready", message: "feat: add retry to uploader (ACME-7)\n\nfunc: ACME_UPLOAD_005\ntask: ACME-7",
  files: [
    { path: "internal/upload/upload.go", added: 42, deleted: 7 },
    { path: "internal/upload/upload_test.go", added: 88, deleted: 0 },
    { path: "assets/logo.png", added: null, deleted: null },
    { path: "docs/releases.md", oldPath: "docs/release.md", added: 0, deleted: 0 },
  ],
  ...over,
});
const flat = (nodes: NodeDesc[], depth = 0): string[] =>
  nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.label} | ${n.description}`, ...(n.kind === "file" ? [] : flat(n.children, depth + 1))]);

{
  const { message, roots } = describeChanges(state(), NOW);
  assert.strictEqual(message, undefined);
  assert.deepStrictEqual(flat(roots), [
    "feat: add retry to uploader (ACME-7) | 1596c39 · rin · 2h ago",
    "  assets | 1",
    "    logo.png | binary",
    "  docs | 1",
    "    releases.md | ← docs/release.md  +0 −0",
    "  internal/upload | 2",
    "    upload.go | +42 −7",
    "    upload_test.go | +88 −0",
  ]);
  console.log("ok - commit node on top, then the folder tree with +/− descriptions");
}
{
  const [root] = describeChanges(state(), NOW).roots;
  assert.strictEqual(root.kind, "commit");
  assert.ok(root.tooltip.startsWith("feat: add retry to uploader (ACME-7)\n\nfunc: ACME_UPLOAD_005\ntask: ACME-7\n\n"), "full message keeps its line breaks");
  assert.match(root.tooltip, /rin <rin@example\.com> · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · acme-api/);
  assert.ok(root.tooltip.endsWith(commit.sha));
  console.log("ok - the commit tooltip carries the full message, author email, date, repo and SHA");
}
{
  const files = (describeChanges(state(), NOW).roots[0] as { children: NodeDesc[] }).children.flatMap((n) => (n.kind === "folder" ? n.children : [n]));
  const byLabel = new Map(files.map((n) => [n.label, n]));
  const logo = byLabel.get("logo.png")!;
  const upload = byLabel.get("upload.go")!;
  assert.ok(logo.kind === "file" && !logo.openable, "binary files cannot be opened as a text diff");
  assert.ok(upload.kind === "file" && upload.openable && upload.path === "internal/upload/upload.go");
  assert.strictEqual(upload.tooltip, "internal/upload/upload.go");
  assert.strictEqual(byLabel.get("releases.md")!.tooltip, "docs/release.md → docs/releases.md");
  console.log("ok - files carry their full path; binaries are not openable; renames show both paths");
}
{
  const ids = (nodes: NodeDesc[]): string[] => nodes.flatMap((n) => [n.id, ...(n.kind === "file" ? [] : ids(n.children))]);
  const all = ids(describeChanges(state(), NOW).roots);
  assert.strictEqual(new Set(all).size, all.length, "ids are unique so VS Code keeps expand state");
  assert.deepStrictEqual(ids(describeChanges(state(), NOW + 60).roots), all, "ids do not depend on time");
  console.log("ok - node ids are unique and stable");
}
{
  assert.deepStrictEqual(describeChanges(null, NOW), { message: NO_SELECTION, roots: [] });
  assert.strictEqual(NO_SELECTION, "Select a commit in the Log to see its changed files.");
  const loading = describeChanges(state({ status: "loading", files: [] }), NOW);
  assert.strictEqual(loading.message, LOADING);
  assert.strictEqual(loading.roots.length, 1, "the commit node shows while its files load");
  assert.strictEqual(describeChanges(state({ status: "error", files: [], error: "bad object" }), NOW).message, "Could not read this commit: bad object");
  assert.strictEqual(describeChanges(state({ files: [] }), NOW).message, NO_FILES);
  console.log("ok - no selection, loading, error and no-files each have a message");
}
{
  assert.strictEqual(firstOpenable(state().files)?.path, "internal/upload/upload.go");
  assert.strictEqual(firstOpenable([{ path: "a.png", added: null, deleted: null }]), undefined);
  assert.strictEqual(firstOpenable([]), undefined);
  console.log("ok - firstOpenable skips binaries and is undefined when nothing can be opened");
}
{
  assert.deepStrictEqual(decorationFor("A"), { badge: "A", color: "gitDecoration.addedResourceForeground", tooltip: "Added" });
  assert.deepStrictEqual(decorationFor("M"), { badge: "M", color: "gitDecoration.modifiedResourceForeground", tooltip: "Modified" });
  assert.deepStrictEqual(decorationFor("D"), { badge: "D", color: "gitDecoration.deletedResourceForeground", tooltip: "Deleted" });
  assert.deepStrictEqual(decorationFor("R"), { badge: "R", color: "gitDecoration.renamedResourceForeground", tooltip: "Renamed" });
  assert.deepStrictEqual(decorationFor("C"), { badge: "C", color: "gitDecoration.addedResourceForeground", tooltip: "Copied" });
  assert.deepStrictEqual(decorationFor("T"), { badge: "T", color: "gitDecoration.modifiedResourceForeground", tooltip: "Type changed" });
  assert.strictEqual(decorationFor(undefined), undefined);
  console.log("ok - each change status maps to the theme's git decoration color and a badge");
}
