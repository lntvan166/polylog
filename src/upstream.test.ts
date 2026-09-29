import * as assert from "assert";
import { aheadBehindArgs, behindRepos, fetchArgs, parseAheadBehind, syncLabel } from "./upstream";

{
  assert.deepStrictEqual(aheadBehindArgs(), ["rev-list", "--left-right", "--count", "HEAD...@{upstream}", "--"], "local refs only: no fetch");
  assert.deepStrictEqual(parseAheadBehind("2\t3\n"), { ahead: 2, behind: 3 }, "left is HEAD's own commits, right the upstream's");
  assert.deepStrictEqual(parseAheadBehind("0\t0\n"), { ahead: 0, behind: 0 });
  assert.strictEqual(parseAheadBehind("fatal: no upstream configured\n"), null, "anything else: nothing to show");
  assert.strictEqual(parseAheadBehind(""), null);
  console.log("ok - ahead/behind its upstream, from git rev-list --left-right --count");
}
{
  assert.strictEqual(syncLabel({ ahead: 0, behind: 0 }), null, "up to date: no badge");
  assert.deepStrictEqual(syncLabel({ ahead: 0, behind: 3 }), { text: "↓3", title: "3 commits to pull from its upstream", behind: true });
  assert.deepStrictEqual(syncLabel({ ahead: 1, behind: 0 }), { text: "↑1", title: "1 commit not pushed", behind: false });
  assert.deepStrictEqual(syncLabel({ ahead: 2, behind: 1 }), { text: "↓1 ↑2", title: "1 commit to pull from its upstream, 2 commits not pushed", behind: true });
  console.log("ok - the Repositories pane badge: ↓ to pull, ↑ not pushed");
}
{
  assert.deepStrictEqual(fetchArgs(false), ["fetch", "--quiet"], "the default remote, as VS Code's Fetch");
  assert.deepStrictEqual(fetchArgs(true), ["fetch", "--quiet", "--prune"], "git.pruneOnFetch");
  const sync = { "/ws/acme-api": { ahead: 0, behind: 3 }, "/ws/acme-libs": { ahead: 2, behind: 0 }, "/ws/acme-web": { ahead: 1, behind: 1 } };
  assert.deepStrictEqual(behindRepos(["/ws/acme-web", "/ws/acme-api", "/ws/acme-libs"], sync), ["/ws/acme-web", "/ws/acme-api"], "behind only (not merely ahead), in repo order");
  assert.deepStrictEqual(behindRepos(["/ws/acme-web"], {}), []);
  console.log("ok - Fetch All's arguments; the repositories behind their upstream");
}
