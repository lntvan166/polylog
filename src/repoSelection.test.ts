import * as assert from "assert";
import { ALL_REPOS, CHART_COLORS, repoColor, selectionFromRepoIds, repoIdsFromSelection } from "./repoSelection";

const ids = ["/ws/acme-api", "/ws/acme-libs", "/ws/acme-web"];

{
  assert.strictEqual(repoIdsFromSelection([]), null, "nothing selected shows every repo");
  assert.strictEqual(repoIdsFromSelection([ALL_REPOS]), null);
  assert.strictEqual(repoIdsFromSelection([ALL_REPOS, "/ws/acme-api"]), null, "All wins over a mixed selection");
  assert.deepStrictEqual(repoIdsFromSelection(["/ws/acme-web"]), ["/ws/acme-web"]);
  assert.deepStrictEqual(repoIdsFromSelection(["/ws/acme-web", "/ws/acme-api", "/ws/acme-web"]), ["/ws/acme-web", "/ws/acme-api"], "deduped, click order kept");
  console.log("ok - a tree selection becomes the Log's repo filter");
}
{
  assert.deepStrictEqual(selectionFromRepoIds(null, ids), [ALL_REPOS]);
  assert.deepStrictEqual(selectionFromRepoIds(["/ws/acme-libs", "/ws/gone"], ids), ["/ws/acme-libs"], "stale ids are dropped");
  assert.deepStrictEqual(selectionFromRepoIds([], ids), [], "None selects nothing");
  console.log("ok - the Log's repo filter becomes the tree selection");
}
{
  assert.deepStrictEqual(CHART_COLORS, ["charts.red", "charts.blue", "charts.yellow", "charts.green", "charts.purple", "charts.orange"]);
  assert.strictEqual(repoColor("/ws/acme-libs", null, ids), "charts.blue", "same hue as the repo's chip in the Log");
  assert.strictEqual(repoColor("/ws/acme-web", ["/ws/acme-web"], ids), "charts.red", "a filtered set takes hues in selection order, as the chips do");
  console.log("ok - repo names use the same chart color as their Log chip");
}
