import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseShow, showArgs } from "./commitDetail";
import { DEFAULT_FILTER, historyArgs, logArgs, type FilterState } from "./filterModel";
import { commitAt, gitEnv, makeRepo } from "./fixtures";
import { GitError, runGit } from "./git";
import { parseHistory, parseLog } from "./gitLog";
import { isAbortError } from "./pool";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-git-test-"));
Object.assign(process.env, gitEnv(home)); // runGit inherits process.env
const ALL: FilterState = { ...DEFAULT_FILTER, date: "all" };
const git = (dir: string, args: string[]) => execFileSync("git", args, { cwd: dir, env: gitEnv(home), stdio: "pipe" }).toString().trim();

const api = path.join(home, "acme-api");
makeRepo(api, [
  { time: 1000, author: "dana", message: "feat: scaffold api", files: { "upload.go": "package upload\n", "logo.png": "\x00\x01\x02", "sp ace é.txt": "a\n" } },
  { time: 2000, author: "rin", message: "fix(api) guard nil response" },
  { time: 2000, author: "dana", message: "[ACME-7] add retry" },
  { time: 3000, author: "rin", message: "café: rename", files: { "sp ace é.txt": null, "renamed.txt": "a\n" } },
], home);

const log = async (f: FilterState, o: { now?: number; cursor?: { skip: number } } = {}) =>
  parseLog(await runGit(api, logArgs(f, { pageSize: 50, now: o.now ?? 10_000, cursor: o.cursor })), api);

(async () => {
  {
    const cs = await log(ALL);
    assert.deepStrictEqual(cs.map((c) => [c.time, c.subject]), [
      [3000, "café: rename"], [2000, "[ACME-7] add retry"], [2000, "fix(api) guard nil response"], [1000, "feat: scaffold api"],
    ]);
    assert.deepStrictEqual(cs[3].parents, []);
    console.log("ok - runGit + parseLog read a real repository, newest first");
  }
  {
    const cs = await log(ALL, { cursor: { skip: 1 } });
    assert.deepStrictEqual(cs.map((c) => c.subject), ["[ACME-7] add retry", "fix(api) guard nil response", "feat: scaffold api"]);
    console.log("ok - --skip resumes at a walk position");
  }
  {
    const cs = await log({ ...ALL, date: "24h" }, { now: 2500 + 86_400 });
    assert.deepStrictEqual(cs.map((c) => c.subject), ["café: rename"]);
    console.log("ok - --since in ISO form limits by committer date");
  }
  {
    assert.deepStrictEqual((await log({ ...ALL, text: "FIX(API)" })).map((c) => c.subject), ["fix(api) guard nil response"]);
    assert.deepStrictEqual((await log({ ...ALL, text: "[acme-7]" })).map((c) => c.subject), ["[ACME-7] add retry"]);
    assert.deepStrictEqual(await log({ ...ALL, text: "." }), [], "a literal dot matches nothing here; as a regex it would match all");
    console.log("ok - search is literal and case-insensitive against real git");
    assert.deepStrictEqual((await log({ ...ALL, author: "RIN" })).map((c) => c.subject), ["café: rename", "fix(api) guard nil response"]);
    assert.deepStrictEqual((await log({ ...ALL, author: "dana@example.com", text: "retry" })).map((c) => c.subject), ["[ACME-7] add retry"]);
    assert.deepStrictEqual(await log({ ...ALL, author: "rin", text: "retry" }), [], "author AND search, never OR");
    console.log("ok - --author matches name or email and combines with --grep as AND");
    const hist = parseHistory(await runGit(api, historyArgs(ALL, { pageSize: 50, now: 10_000, path: "renamed.txt" })), api, "renamed.txt");
    assert.deepStrictEqual(hist.map((c) => [c.subject, c.file?.path, c.file?.status]), [
      ["café: rename", "renamed.txt", "R"],
      ["feat: scaffold api", "sp ace é.txt", "A"],
    ], "history follows the rename back to the file's first name");
    console.log("ok - real git: file history follows a rename");
  }
  {
    git(api, ["config", "i18n.logOutputEncoding", "ISO-8859-1"]);
    git(api, ["config", "log.showSignature", "true"]);
    assert.strictEqual((await log(ALL))[0].subject, "café: rename");
    git(api, ["config", "--unset", "i18n.logOutputEncoding"]);
    git(api, ["config", "--unset", "log.showSignature"]);
    console.log("ok - user git config cannot change the output encoding or add signature lines");
  }
  {
    const [renameSha, , , rootSha] = (await log(ALL)).map((c) => c.sha);
    const root = parseShow(await runGit(api, showArgs(rootSha))).files;
    assert.deepStrictEqual(root.find((f) => f.path === "logo.png"), { path: "logo.png", added: null, deleted: null, status: "A" });
    assert.deepStrictEqual(root.find((f) => f.path === "sp ace é.txt"), { path: "sp ace é.txt", added: 1, deleted: 0, status: "A" });
    assert.strictEqual(parseShow(await runGit(api, showArgs(renameSha))).message, "café: rename");
    assert.deepStrictEqual(parseShow(await runGit(api, showArgs(renameSha))).files, [{ path: "renamed.txt", oldPath: "sp ace é.txt", added: 0, deleted: 0, status: "R" }]);
    console.log("ok - numstat on real commits: binary, unicode path, rename");
  }
  {
    const web = path.join(home, "acme-web");
    makeRepo(web, [{ time: 100, author: "dana", message: "base", files: { "a.txt": "a\n" } }], home);
    git(web, ["checkout", "-q", "-b", "side"]);
    commitAt(web, home, { time: 200, author: "rin", message: "side work", files: { "side.txt": "s\n" } });
    git(web, ["checkout", "-q", "main"]);
    commitAt(web, home, { time: 300, author: "dana", message: "main work", files: { "main.txt": "m\n" } });
    execFileSync("git", ["merge", "-q", "--no-ff", "side", "-m", "merge side"], {
      cwd: web, stdio: "pipe",
      env: { ...gitEnv(home), GIT_AUTHOR_NAME: "dana", GIT_AUTHOR_EMAIL: "dana@example.com", GIT_COMMITTER_NAME: "dana", GIT_COMMITTER_EMAIL: "dana@example.com", GIT_AUTHOR_DATE: "@400 +0000", GIT_COMMITTER_DATE: "@400 +0000" },
    });
    const merge = parseLog(await runGit(web, logArgs(ALL, { pageSize: 1, now: 0 })), web)[0];
    assert.strictEqual(merge.parents.length, 2);
    assert.deepStrictEqual(parseShow(await runGit(web, showArgs(merge.sha))).files, [{ path: "side.txt", added: 1, deleted: 0, status: "A" }]);
    console.log("ok - a merge commit lists files against its first parent");
  }
  {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "polylog-not-a-repo-"));
    await assert.rejects(runGit(notRepo, ["log"]), (e: unknown) =>
      e instanceof GitError && /not a git repository/i.test(e.message) && !e.message.startsWith("fatal:"));
    const sha = (await log(ALL))[0].sha;
    await assert.rejects(runGit(api, ["show", `${sha}:missing.txt`]), GitError);
    console.log("ok - git failures reject with a readable GitError");
  }
  {
    const ctl = new AbortController();
    const pending = runGit(api, ["log"], ctl.signal);
    ctl.abort();
    await assert.rejects(pending, (e: unknown) => isAbortError(e));
    console.log("ok - aborting kills the process and rejects with AbortError");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
