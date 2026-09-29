import * as assert from "assert";
import { commitWebUrl } from "./remoteUrl";

const SHA = "a".repeat(40);
{
  const cases: [string, string | null][] = [
    ["git@github.com:acme/acme-web.git", `https://github.com/acme/acme-web/commit/${SHA}`],
    ["https://github.com/acme/acme-web.git", `https://github.com/acme/acme-web/commit/${SHA}`],
    ["https://github.com/acme/acme-web", `https://github.com/acme/acme-web/commit/${SHA}`],
    ["ssh://git@github.com/acme/acme-web.git", `https://github.com/acme/acme-web/commit/${SHA}`],
    ["git@gitlab.com:acme/tools/acme-api.git", `https://gitlab.com/acme/tools/acme-api/-/commit/${SHA}`],
    ["ssh://git@gitlab.acme.test:2222/acme/acme-api.git", `https://gitlab.acme.test/acme/acme-api/-/commit/${SHA}`],
    ["git@bitbucket.org:acme/acme-libs.git", `https://bitbucket.org/acme/acme-libs/commits/${SHA}`],
    ["https://dev.azure.com/acme/web/_git/acme-web", `https://dev.azure.com/acme/web/_git/acme-web/commit/${SHA}`],
    ["git@ssh.dev.azure.com:v3/acme/web/acme-web", `https://dev.azure.com/acme/web/_git/acme-web/commit/${SHA}`],
    ["https://git.acme.test/acme/acme-web.git", `https://git.acme.test/acme/acme-web/commit/${SHA}`],
    ["/srv/git/acme-web.git", null],
    ["C:\\repos\\acme-web.git", null],
    ["C:/repos/acme-web.git", null],
    ["file:///srv/git/acme-web.git", null],
    ["", null],
  ];
  for (const [remote, url] of cases) assert.strictEqual(commitWebUrl(remote, SHA), url, remote);
  console.log("ok - a commit's page from its remote: GitHub, GitLab, Bitbucket, Azure DevOps, others; none for a local path");
}
{
  // A token in the remote URL must never end up in a browser, its history, or a proxy log.
  assert.strictEqual(commitWebUrl("https://dana:ghp_secret@github.com/acme/acme-web.git", SHA), `https://github.com/acme/acme-web/commit/${SHA}`);
  assert.strictEqual(commitWebUrl("https://oauth2:tok@gitlab.com/acme/acme-api.git", SHA), `https://gitlab.com/acme/acme-api/-/commit/${SHA}`);
  assert.strictEqual(commitWebUrl("http://git.acme.test:8080/acme/acme-web.git", SHA), `http://git.acme.test:8080/acme/acme-web/commit/${SHA}`, "an http port is kept (a web server); an ssh port is not");
  assert.strictEqual(commitWebUrl("git@github.com:acme/acme-web.git", "not-a-sha"), null, "only a commit id");
  console.log("ok - credentials in the remote URL are dropped, never opened");
}
