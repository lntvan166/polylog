import * as assert from "assert";
import { DEFAULT_FILTER, type FilterState } from "../filterModel";
import {
  absoluteTime, accentIndex, ACCENT_COUNT, countLabel, dateLabel, emptyState, moveSelection,
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
  assert.strictEqual(ACCENT_COUNT, 6);
  assert.strictEqual(accentIndex("/ws/acme-api", null), null, "unfiltered: no color");
  assert.strictEqual(accentIndex("/ws/acme-api", ["/ws/acme-web", "/ws/acme-api"]), 1);
  assert.strictEqual(accentIndex("/ws/x", Array.from({ length: 7 }, (_, i) => i === 0 ? "/ws/x" : `/ws/${i}`)), null, "more than six: no color");
  console.log("ok - accents only for a filtered set of at most six repos");
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
  assert.strictEqual(text.body, "No commit message contains “ACME-7” in 3 repositories in the last 30 days.");
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
