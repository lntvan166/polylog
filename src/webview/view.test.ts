import * as assert from "assert";
import { DEFAULT_FILTER, type FilterState } from "../filterModel";
import {
  absoluteTime, accentOf, ACCENT_COUNT, assignAccents, fitMiddle, middleTruncate, repoColumnChars, branchUseLabel, countLabel, dateLabel, emptyState, moveSelection,
  relativeTime, repoButtonLabel, reselect, splitPath, visibleRange,
} from "./view";

const NOW = 1790164800;
const ALL: FilterState = { ...DEFAULT_FILTER, date: "all" };
const repos = ["acme-web", "acme-api", "acme-libs"].map((n) => ({ id: `/ws/${n}`, name: n }));

{
  assert.strictEqual(relativeTime(NOW, NOW - 5), "just now");
  assert.strictEqual(relativeTime(NOW, NOW + 3600), "just now", "clock skew never shows negative");
  assert.strictEqual(relativeTime(NOW, NOW - 5 * 60), "5m ago");
  assert.strictEqual(relativeTime(NOW, NOW - 2 * 3600), "2h ago");
  assert.strictEqual(relativeTime(NOW, NOW - 86_400), "1d ago");
  assert.strictEqual(relativeTime(NOW, NOW - 45 * 86_400), "1mo ago");
  assert.strictEqual(relativeTime(NOW, NOW - 800 * 86_400), "2y ago");
  assert.match(absoluteTime(NOW), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  console.log("ok - relative and absolute time labels");
}
{
  assert.deepStrictEqual(visibleRange(0, 400, 40, 1000, 8), { start: 0, end: 18 });
  assert.deepStrictEqual(visibleRange(4000, 400, 40, 1000, 8), { start: 92, end: 118 });
  assert.deepStrictEqual(visibleRange(39_900, 400, 40, 1000, 8), { start: 989, end: 1000 });
  assert.deepStrictEqual(visibleRange(0, 400, 40, 0), { start: 0, end: 0 });
  console.log("ok - visibleRange renders only the window plus overscan");
}
{
  assert.strictEqual(moveSelection("ArrowDown", -1, 10, 5), 0);
  assert.strictEqual(moveSelection("ArrowDown", 9, 10, 5), 9);
  assert.strictEqual(moveSelection("ArrowUp", 0, 10, 5), 0);
  assert.strictEqual(moveSelection("ArrowUp", -1, 10, 5), 0);
  assert.strictEqual(moveSelection("Home", 7, 10, 5), 0);
  assert.strictEqual(moveSelection("End", 2, 10, 5), 9);
  assert.strictEqual(moveSelection("PageDown", 2, 10, 5), 7);
  assert.strictEqual(moveSelection("PageUp", 2, 10, 5), 0);
  assert.strictEqual(moveSelection("a", 2, 10, 5), null);
  assert.strictEqual(moveSelection("ArrowDown", -1, 0, 5), null);
  console.log("ok - keyboard selection clamps to the list");
}
{
  const repo = (name: string) => ({ id: `/ws/${name}`, name });
  const six = ["acme-api", "acme-docs", "acme-infra", "acme-libs", "acme-mobile", "acme-web"].map(repo);
  const a = assignAccents(six);
  assert.strictEqual(ACCENT_COUNT, 6);
  assert.strictEqual(new Set(six.map((r) => a.get(r.id))).size, 6, "six repositories get six different hues");
  assert.deepStrictEqual(assignAccents([...six].reverse()), a, "the order repositories were discovered in does not matter");
  const withLast = assignAccents([...six, repo("acme-zeta")]);
  assert.ok(six.every((r) => withLast.get(r.id) === a.get(r.id)), "a repository that sorts last moves nobody");
  // Honest limit (spec §18): one that sorts early can move repos after it in name order.
  const many = Array.from({ length: 20 }, (_, i) => repo(`svc-${i}`));
  const m = assignAccents(many);
  const counts = new Map<number, number>();
  for (const r of many) counts.set(m.get(r.id)!, (counts.get(m.get(r.id)!) ?? 0) + 1);
  assert.ok(Math.max(...counts.values()) - Math.min(...counts.values()) <= 1, "past six, hues are shared evenly");
  assert.strictEqual(accentOf(a, "/ws/unknown"), 0, "a repository outside the list still renders");
  console.log("ok - each repo keeps one hue: from its name, distinct up to six, the same under any filter");
}
{
  assert.strictEqual(repoButtonLabel(null, repos), "All repositories");
  assert.strictEqual(repoButtonLabel([], repos), "No repositories");
  assert.strictEqual(repoButtonLabel(["/ws/acme-api"], repos), "acme-api");
  assert.strictEqual(repoButtonLabel(["/ws/acme-api", "/ws/acme-web"], repos), "2 of 3 repositories");
  console.log("ok - repo picker label");
}
{
  assert.strictEqual(dateLabel(ALL), "");
  assert.strictEqual(dateLabel({ ...ALL, date: "24h" }), " in the last 24 hours");
  assert.strictEqual(dateLabel({ ...ALL, date: "custom", from: "2026-09-01", to: "2026-09-10" }), " between 2026-09-01 and 2026-09-10");
  assert.strictEqual(dateLabel({ ...ALL, date: "custom", from: "2026-09-01" }), " since 2026-09-01");
  assert.strictEqual(dateLabel({ ...ALL, date: "custom" }), "");
  console.log("ok - date labels read as sentence fragments");
}
{
  assert.deepStrictEqual(emptyState({ repoCount: 0, filter: ALL }).action, { label: "Open Settings", id: "settings" });
  assert.match(emptyState({ repoCount: 0, filter: ALL }).body, /git\.repositoryScanMaxDepth/);
  assert.match(emptyState({ repoCount: 0, filter: ALL }).body, /polylog\.scanDepth/);
  assert.deepStrictEqual(emptyState({ repoCount: 3, filter: { ...ALL, repoIds: [] } }).action?.id, "selectAll");
  const text = emptyState({ repoCount: 3, filter: { ...DEFAULT_FILTER, text: "ACME-7" } });
  assert.strictEqual(text.body, "No commit message contains “ACME-7” in 3 repositories in the last 24 hours.");
  assert.strictEqual(text.action?.id, "clearText");
  const date = emptyState({ repoCount: 1, filter: { ...ALL, date: "24h" } });
  assert.strictEqual(date.body, "No commits in 1 repository in the last 24 hours.");
  assert.strictEqual(date.action?.id, "allTime");
  assert.strictEqual(emptyState({ repoCount: 3, filter: { ...ALL, repoIds: ["/ws/acme-api"] } }).action?.id, "selectAll");
  const none = emptyState({ repoCount: 3, filter: ALL });
  assert.match(none.body, /one merged log/);
  assert.match(none.body, /found 3 repositories/);
  assert.strictEqual(none.action, undefined);
  console.log("ok - each empty state names its cause and offers the matching fix");
}
{
  assert.strictEqual(countLabel(1), "1 commit");
  assert.strictEqual(countLabel(214), "214 commits");
  assert.deepStrictEqual(splitPath("internal/upload/upload.go"), { dir: "internal/upload", base: "upload.go" });
  assert.deepStrictEqual(splitPath("README.md"), { dir: "", base: "README.md" });
  console.log("ok - count label and path split");
}
{
  const rows = ["a", "b", "c"].map((sha) => ({ repoId: "/ws/acme-web", sha }));
  assert.strictEqual(reselect("/ws/acme-web\0b", rows), 1, "a replayed or refreshed page keeps the selected commit");
  assert.strictEqual(reselect("/ws/acme-web\0gone", rows), 0, "a commit no longer listed falls back to the first row");
  assert.strictEqual(reselect(null, rows), 0);
  assert.strictEqual(reselect("/ws/acme-web\0a", []), -1, "no rows, no selection");
  console.log("ok - reselect keeps the selection across a replay or refresh");
}
{
  const by = emptyState({ repoCount: 3, filter: { ...ALL, author: "rin" } });
  assert.strictEqual(by.body, "No commits by “rin” in 3 repositories.");
  assert.deepStrictEqual(by.action, { label: "Clear Author", id: "clearAuthor" });
  const both = emptyState({ repoCount: 3, filter: { ...DEFAULT_FILTER, text: "ACME-7", author: "dana" } });
  assert.strictEqual(both.body, "No commit by “dana” contains “ACME-7” in 3 repositories in the last 24 hours.");
  assert.strictEqual(both.action?.id, "clearText");
  console.log("ok - empty states name the author filter and offer to clear it");
}
{
  const h = emptyState({ repoCount: 3, filter: DEFAULT_FILTER, history: "src/client.ts" });
  assert.strictEqual(h.body, "No commits to src/client.ts in the last 24 hours.");
  assert.strictEqual(h.action?.id, "allTime");
  assert.strictEqual(emptyState({ repoCount: 3, filter: { ...ALL, text: "zzz" }, history: "a.ts" }).body, "No commit to a.ts contains “zzz”.");
  console.log("ok - file history has its own empty state");
}
{
  assert.strictEqual(branchUseLabel({ branch: "origin/prod", found: 52, fallback: 16 }), "origin/prod in 52 repos · current branch in 16");
  assert.strictEqual(branchUseLabel({ branch: "origin/prod", found: 3, fallback: 0 }), "origin/prod in all 3 repos");
  assert.strictEqual(branchUseLabel({ branch: "prod", found: 0, fallback: 2 }), "no repo has prod · current branch in 2");
  assert.strictEqual(branchUseLabel(undefined), "");
  console.log("ok - the footer says which repos use the branch and which fell back");
}
{
  assert.strictEqual(middleTruncate("acme-web", 12), "acme-web", "short names are untouched");
  assert.strictEqual(middleTruncate("acme-mobile-shipper-ops", 16), "acme-mob…per-ops", "long names keep their start and their end");
  assert.strictEqual(middleTruncate("acme-mobile-shipper-ops", 16).length, 16);
  assert.notStrictEqual(middleTruncate("acme-mobile-shipper-ops", 16), middleTruncate("acme-mobile-shipper-app", 16), "names that share a start stay apart");
  assert.strictEqual(middleTruncate("abcdef", 1), "…");
  assert.strictEqual(middleTruncate("😀😀😀😀😀", 3), "😀…😀", "never splits a character made of two UTF-16 units");
  console.log("ok - long repo names are cut in the middle, so the part that tells them apart stays");
}
{
  assert.strictEqual(repoColumnChars(["acme-web", "acme-api"]), 10, "never narrower than 10 characters");
  assert.strictEqual(repoColumnChars(["acme-web", "acme-mobile-shipper"]), 19, "fits the longest name");
  assert.strictEqual(repoColumnChars(["a".repeat(60)]), 28, "and stops at 28");
  assert.strictEqual(repoColumnChars([]), 10);
  console.log("ok - the repo column fits the workspace's longest repo name, within limits");
}
{
  // A fake measure: 7px per character.
  const within = (px: number) => (t: string) => t.length * 7 <= px;
  assert.strictEqual(fitMiddle("acme-mobile-shipper-ops", within(1000)), "acme-mobile-shipper-ops", "a name that fits is untouched");
  const cut = fitMiddle("acme-mobile-shipper-ops", within(112));
  assert.strictEqual(cut, "acme-mob…per-ops", "otherwise the longest middle cut that fits (16 × 7 = 112px)");
  assert.notStrictEqual(cut, fitMiddle("acme-mobile-shipper-app", within(112)), "so similar names stay apart at any width");
  assert.strictEqual(fitMiddle("acme-web", within(3)), "…", "no room at all still renders");
  console.log("ok - a repo name is cut in the middle to exactly what fits the space it has");
}
