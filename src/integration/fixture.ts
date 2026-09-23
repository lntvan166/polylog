import type { FixtureCommit } from "../fixtures";

export const T0 = 1758000000;

export const FIXTURE: Record<"acme-web" | "acme-api" | "acme-libs", FixtureCommit[]> = {
  "acme-api": [
    { time: T0, author: "dana", message: "feat: scaffold api", files: { "upload.go": "package upload\n" } },
    { time: T0 + 300, author: "rin", message: "feat: add retry to uploader (ACME-7)", files: { "upload.go": "package upload\n\nfunc Retry() {}\n" } },
  ],
  "acme-web": [
    { time: T0 + 100, author: "rin", message: "feat: scaffold web", files: { "client.ts": "export {};\n" } },
    { time: T0 + 400, author: "dana", message: "fix: guard nil response", files: { "client.ts": "export const ok = true;\n" } },
  ],
  "acme-libs": [
    { time: T0 + 200, author: "dana", message: "chore: bump deps", files: { "package.json": "{}\n" } },
    { time: T0 + 500, author: "rin", message: "docs: link ACME-7 from the changelog", files: { "CHANGELOG.md": "- ACME-7\n" } },
  ],
};

export const EXPECTED_ORDER = [
  "docs: link ACME-7 from the changelog",
  "fix: guard nil response",
  "feat: add retry to uploader (ACME-7)",
  "chore: bump deps",
  "feat: scaffold web",
  "feat: scaffold api",
];
