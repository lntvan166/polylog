import * as assert from "assert";
import { excludeRepos, globToRegExp, labelRepos } from "./repos";

{
  const repos = labelRepos(["/w/acme-web", "/w/acme-api", "/w/acme-web"]);
  assert.deepStrictEqual(repos, [
    { id: "/w/acme-api", root: "/w/acme-api", name: "acme-api" },
    { id: "/w/acme-web", root: "/w/acme-web", name: "acme-web" },
  ]);
  console.log("ok - labels are folder names, deduped and sorted; id is the root");
}
{
  const repos = labelRepos(["/a/team1/acme-web", "/a/team2/acme-web"]);
  assert.deepStrictEqual(repos.map((r) => r.name), ["acme-web (team1)", "acme-web (team2)"]);
  assert.notStrictEqual(repos[0].id, repos[1].id);
  const twice = labelRepos(["/x/team/acme-web", "/y/team/acme-web"]);
  assert.deepStrictEqual(twice.map((r) => r.name).sort(), ["/x/team/acme-web", "/y/team/acme-web"]);
  console.log("ok - same-named repos get distinct labels (parent folder, then full path)");
}
{
  assert.strictEqual(labelRepos(["C:\\src\\acme-api"])[0].name, "acme-api");
  console.log("ok - Windows paths label by folder name");
}
{
  assert.ok(globToRegExp("acme-*").test("acme-web"));
  assert.ok(!globToRegExp("*").test("a/b"), "* does not cross a slash");
  assert.ok(globToRegExp("**/vendor").test("vendor") && globToRegExp("**/vendor").test("/ws/x/vendor"));
  assert.ok(globToRegExp("**/vendor/**").test("/ws/vendor/lib"));
  assert.ok(!globToRegExp("acme.web").test("acmeXweb"), "regex characters are literal");
  assert.ok(globToRegExp("acme-?pi").test("acme-api"));
  console.log("ok - glob syntax: *, **, ?, literal punctuation");
}
{
  const repos = labelRepos(["/ws/acme-web", "/ws/acme-api", "/ws/vendor/acme-libs", "C:\\ws\\acme-docs"]);
  assert.deepStrictEqual(excludeRepos(repos, []).length, 4);
  assert.deepStrictEqual(excludeRepos(repos, ["acme-web"]).map((r) => r.root), ["/ws/acme-api", "C:\\ws\\acme-docs", "/ws/vendor/acme-libs"]);
  assert.deepStrictEqual(excludeRepos(repos, ["**/vendor/**"]).map((r) => r.root).includes("/ws/vendor/acme-libs"), false);
  assert.deepStrictEqual(excludeRepos(repos, ["C:/ws/*"]).map((r) => r.root).includes("C:\\ws\\acme-docs"), false);
  console.log("ok - excludeRepos matches folder name or full path (slashes normalized)");
}
