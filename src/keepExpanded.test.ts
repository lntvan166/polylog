import * as assert from "assert";
import { collapsedPeer } from "./keepExpanded";

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
