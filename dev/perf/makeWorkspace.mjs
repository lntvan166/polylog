// Builds a neutral 68-repository, ~16k-commit workspace (like the spec's benchmark)
// with git fast-import, so it takes seconds, not minutes. Dev-only.
//   node dev/perf/makeWorkspace.mjs <dir> [repos=68]
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const repos = Number(process.argv[3] ?? 68);
if (!dir) throw new Error("usage: makeWorkspace.mjs <dir> [repos]");
rmSync(dir, { recursive: true, force: true });
const now = Math.floor(Date.now() / 1000);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
let total = 0;
for (let r = 0; r < repos; r++) {
  const name = r < 3 ? ["acme-web", "acme-api", "acme-libs"][r] : `acme-svc-${String(r - 2).padStart(2, "0")}`;
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
  // One large repo, the rest small-to-medium: 5633 + 67 × ~159 ≈ 16.3k commits.
  const commits = r === 0 ? 5633 : 100 + ((r * 37) % 120);
  const chunks = [];
  for (let i = 0; i < commits; i++) {
    const t = now - Math.floor(((commits - i) / commits) * 60 * 86_400) + (r % 7) * 60;
    const author = i % 2 ? "rin" : "dana";
    const msg = `${["feat", "fix", "chore", "docs"][i % 4]}: change ${i} in ${name} (ACME-${(i * 7) % 900})\n`;
    const body = `line ${i}\n`;
    chunks.push(`commit refs/heads/main\nmark :${i + 1}\ncommitter ${author} <${author}@example.com> ${t} +0000\ndata ${Buffer.byteLength(msg)}\n${msg}`
      + (i > 0 ? `from :${i}\n` : "")
      + `M 644 inline src/file${i % 25}.ts\ndata ${Buffer.byteLength(body)}\n${body}\n`);
  }
  execFileSync("git", ["fast-import", "--quiet"], { cwd: repo, env, input: chunks.join("") });
  execFileSync("git", ["checkout", "-q", "main"], { cwd: repo, env });
  if (r % 3 === 0) execFileSync("git", ["branch", "prod", "HEAD~5"], { cwd: repo, env });
  total += commits;
}
console.log(`workspace: ${repos} repos, ${total} commits in ${dir}`);
