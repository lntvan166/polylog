// Dev-only mock data. Neutral names only (CLAUDE.md constraint 3).
import type { Commit, FileChange, Repo } from "../../src/types";

/** 2026-09-23T12:00:00Z — fixed so screenshots are reproducible. */
export const NOW = 1790164800;

const SUBJECTS = [
  "feat: add retry to uploader",
  "fix: guard nil response",
  "chore: bump deps",
  "docs: explain origin/release-1.4 branching",
  "refactor: split request builder",
  "test: cover empty pages",
  "feat(web): keyboard shortcuts for the commit table",
  "fix(api): handle 429 from upstream with backoff and jitter so one burst does not cascade across every client",
  "perf: cache parsed config",
  'revert: "feat: add retry to uploader"',
  "fix: unicode in filenames — café.txt ✓",
  "build: package release-1.4 (ACME-7)",
];
const AUTHORS = ["dana", "rin"] as const;
const BASE = ["acme-web", "acme-api", "acme-libs"];

export function mockRepos(scenario: string): Repo[] {
  if (scenario === "norepos") return [];
  const names = scenario === "many"
    ? [...BASE, ...Array.from({ length: 65 }, (_, i) => `acme-svc-${String(i + 1).padStart(2, "0")}`)]
    : BASE;
  return names.map((name) => ({ id: `/work/${name}`, root: `/work/${name}`, name }));
}

function sha(n: number): string {
  let x = (n * 2654435761) >>> 0;
  let s = "";
  while (s.length < 40) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    s += x.toString(16).padStart(8, "0");
  }
  return s.slice(0, 40);
}

export function mockCommits(repos: Repo[], scenario: string): Commit[] {
  if (scenario === "empty") return [];
  const perRepo = scenario === "many" ? 240 : 40;
  const out: Commit[] = [];
  repos.forEach((r, ri) => {
    for (let i = 0; i < perRepo; i++) {
      const n = ri * 10_000 + i;
      const author = AUTHORS[n % 2];
      out.push({
        repoId: r.id, sha: sha(n), time: NOW - (i * 3 + ri) * 3700 - (n % 7) * 60,
        author, email: `${author}@example.com`, subject: SUBJECTS[n % SUBJECTS.length],
        parents: i === perRepo - 1 ? [] : [sha(n + 1)],
      });
    }
  });
  return out.sort((a, b) => b.time - a.time || (a.sha < b.sha ? -1 : 1));
}

export function mockFiles(commitSha: string): FileChange[] {
  const sets: FileChange[][] = [
    [
      { path: "internal/upload/upload.go", added: 42, deleted: 7 },
      { path: "internal/upload/upload_test.go", added: 88, deleted: 0 },
    ],
    [
      { path: "src/client.ts", added: 3, deleted: 3 },
      { path: "assets/logo.png", added: null, deleted: null },
      { path: "docs/releases.md", oldPath: "docs/release.md", added: 0, deleted: 0 },
    ],
    [{ path: "package.json", added: 1, deleted: 1 }],
    Array.from({ length: 30 }, (_, i) => ({ path: `src/components/table/cells/cell-${i}.ts`, added: i, deleted: 30 - i })),
  ];
  return sets[parseInt(commitSha.slice(0, 2), 16) % sets.length];
}
