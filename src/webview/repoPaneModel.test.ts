import * as assert from "assert";
import { clampPaneWidth, DEFAULT_REPO_PANE_WIDTH, isChecked, pickOnly, toggleRepo, visibleRepos } from "./repoPaneModel";

const all = ["/ws/acme-api", "/ws/acme-libs", "/ws/acme-web"];
const repos = all.map((id) => ({ id, name: id.slice(4) }));

{
  assert.deepStrictEqual(pickOnly("/ws/acme-web"), ["/ws/acme-web"]);
  console.log("ok - clicking a repo name shows only that repo");
}
{
  assert.deepStrictEqual(toggleRepo(null, "/ws/acme-web", all), ["/ws/acme-api", "/ws/acme-libs"], "unticking from All keeps the rest");
  assert.deepStrictEqual(toggleRepo(["/ws/acme-api"], "/ws/acme-web", all), ["/ws/acme-api", "/ws/acme-web"], "ticking adds, in repo order");
  assert.strictEqual(toggleRepo(["/ws/acme-api", "/ws/acme-libs"], "/ws/acme-web", all), null, "ticking the last one back is All");
  assert.deepStrictEqual(toggleRepo(["/ws/acme-api"], "/ws/acme-api", all), [], "unticking the only one is None");
  console.log("ok - checkboxes and Ctrl/Cmd-click toggle membership");
}
{
  assert.ok(isChecked(null, "/ws/acme-api"));
  assert.ok(isChecked(["/ws/acme-api"], "/ws/acme-api") && !isChecked(["/ws/acme-api"], "/ws/acme-web"));
  console.log("ok - isChecked treats null as every repo");
}
{
  assert.deepStrictEqual(visibleRepos(repos, "").map((r) => r.name), ["acme-api", "acme-libs", "acme-web"]);
  assert.deepStrictEqual(visibleRepos(repos, " LIB ").map((r) => r.name), ["acme-libs"]);
  assert.deepStrictEqual(visibleRepos(repos, "zzz"), []);
  console.log("ok - the repo search narrows the list by name, case-insensitively");
}
{
  assert.strictEqual(DEFAULT_REPO_PANE_WIDTH, 190);
  assert.strictEqual(clampPaneWidth(40, 1400), 120, "never narrower than 120px");
  assert.strictEqual(clampPaneWidth(900, 1400), 480, "never wider than 480px");
  assert.strictEqual(clampPaneWidth(400, 600), 300, "always leaves 300px for the Log");
  assert.strictEqual(clampPaneWidth(Number.NaN, 1400), 190, "a corrupt saved width falls back to the default");
  console.log("ok - the repo pane width is clamped to a usable range");
}
