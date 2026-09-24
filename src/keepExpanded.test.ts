import * as assert from "assert";
import { collapsedPeer, UndoCollapse } from "./keepExpanded";

{
  assert.strictEqual(collapsedPeer(true, false), "changes", "Changes header clicked: expand Changes again");
  assert.strictEqual(collapsedPeer(false, true), "log", "Log header clicked: expand the Log again");
  assert.strictEqual(collapsedPeer(undefined, true), "log", "the Log was collapsed before this window opened, so it never loaded");
  console.log("ok - one view collapsed while the other shows: expand it");
}
{
  assert.strictEqual(collapsedPeer(false, false), null, "panel hidden or on another tab: both are hidden, nothing to fix");
  assert.strictEqual(collapsedPeer(undefined, false), null);
  assert.strictEqual(collapsedPeer(true, true), null, "both showing");
  console.log("ok - both hidden (another panel tab) or both showing: leave them");
}
{
  const u = new UndoCollapse(10_000);
  assert.strictEqual(u.decide(true, false, 0, true), "changes", "a collapse is undone");
  assert.strictEqual(u.decide(true, true, 200, true), null, "both showing again: nothing to do");
  assert.strictEqual(u.decide(true, false, 3_000, true), null, "hidden again right after the undo: the user means it (Hide 'Changes', or Changes moved to another container)");
  assert.strictEqual(u.decide(true, false, 60_000, true), null, "and Polylog stops fighting for that view until reload");
  assert.strictEqual(u.decide(false, true, 60_000, true), "log", "the other view is still looked after");
  console.log("ok - a collapse is undone once; hiding the same view again right away is respected");
}
{
  const u = new UndoCollapse(10_000);
  assert.strictEqual(u.decide(true, false, 0, true), "changes");
  assert.strictEqual(u.decide(true, false, 20_000, true), "changes", "a collapse long after the last undo is an accident again");
  assert.strictEqual(new UndoCollapse(10_000).decide(true, false, 0, false), null, "polylog.keepViewsExpanded off: never");
  console.log("ok - accidental collapses far apart are each undone; the setting turns it off");
}
{
  const u = new UndoCollapse(10_000);
  assert.strictEqual(u.decide(true, false, 0, true, { log: true, changes: false }), null, "Changes cannot be revealed yet (no commit selected): skip, without taking focus");
  assert.strictEqual(u.decide(true, false, 2_000, true), "changes", "and a skipped attempt does not count as an undo");
  console.log("ok - a view that cannot be expanded quietly yet is retried later, not given up on");
}
