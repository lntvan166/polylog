import type { CompareHost, CompareWebview, CFile, CCommit } from "../../src/compareProtocol";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "dark";
const BODY_CLASS: Record<string, string> = {
  dark: "vscode-dark",
  light: "vscode-light",
  "hc-dark": "vscode-high-contrast",
  "hc-light": "vscode-high-contrast vscode-high-contrast-light",
};
(document.getElementById("theme") as HTMLLinkElement).href = `themes/${theme}.css`;
document.addEventListener("DOMContentLoaded", () => {
  document.body.className = BODY_CLASS[theme] ?? BODY_CLASS.dark;
});
const send = (m: CompareHost, ms = 30) => setTimeout(() => window.postMessage(m, "*"), ms);
const f = (path: string, added: number | null, deleted: number | null, both = false): CFile => ({ path, added, deleted, both, status: "M" });
const c = (sha: string, subject: string, author: string, days: number): CCommit => ({ sha: sha.padEnd(40, "0"), parent: "f".repeat(40), subject, author, time: Math.floor(Date.now() / 1000) - days * 86400, files: null });
let pair = { left: "origin/release-1.4", right: "origin/main" };
let mode: "files" | "commits" = "files";
const rows = [
  { repoId: "/work/acme-api", name: "acme-api", accent: 1, status: "differs" as const, left: 2, right: 1, same: 1, behind: true },
  { repoId: "/work/acme-web", name: "acme-web", accent: 2, status: "differs" as const, left: 5, right: 0, same: 0, behind: false },
  { repoId: "/work/acme-legacy", name: "acme-legacy", accent: 3, status: "nobase" as const, left: 0, right: 0, same: 0, behind: false },
  { repoId: "/work/acme-tools", name: "acme-tools", accent: 4, status: "error" as const, left: 0, right: 0, same: 0, reason: "bad object refs/remotes/origin/release-1.4", behind: false },
];
function detail(repoId: string): void {
  if (mode === "files") send({ type: "detail", repoId, mode, left: [f("src/limit.go", 40, 0), f("src/client.go", 3, 1, true), f("assets/logo.png", null, null)], right: [f("src/client.go", 1, 1, true), f("src/timeout.go", 2, 2)], more: { left: false, right: false }, duplicates: [{ subject: "fix: retry on 503", left: "3f9a2c1".padEnd(40, "0"), right: "b71e0d4".padEnd(40, "0") }] });
  else send({ type: "detail", repoId, mode, left: [c("a1", "feat: rate limit per client", "dana", 2), c("a2", "fix: guard nil response", "rin", 3)], right: [c("b1", "hotfix: raise upstream timeout", "dana", 0.2)], more: { left: false, right: false }, duplicates: [{ subject: "fix: retry on 503", left: "3f9a2c1".padEnd(40, "0"), right: "b71e0d4".padEnd(40, "0") }] });
}
function state(): void {
  send({ type: "state", pair, mode, recent: [pair, { left: "origin/release-1.3", right: "origin/prod" }], favorites: ["origin/main"], message: pair.left === pair.right ? `Pick two different branches. Both sides are ${pair.left}.` : undefined });
}
function handle(m: CompareWebview): void {
  console.info("[compare harness]", m);
  switch (m.type) {
    case "ready":
      state();
      send({ type: "branches", names: [{ name: "origin/main", count: 68 }, { name: "main", count: 68 }, { name: "origin/release-1.4", count: 56 }, { name: "origin/release-1.3", count: 56 }, { name: "origin/prod", count: 44 }, { name: "feat/billing", count: 3 }] });
      send({ type: "repos", reading: false, summary: "4 repositories differ · ◀7 ▶1 =1 · 51 identical · 12 missing a branch · in 68 repositories", rows, identical: 51, missing: ["acme-docs", "acme-infra", "acme-ops"], selected: "/work/acme-api" });
      detail("/work/acme-api");
      return;
    case "pick": pair = m.pair; state(); detail("/work/acme-api"); return;
    case "swap": pair = { left: pair.right, right: pair.left }; state(); detail("/work/acme-api"); return;
    case "mode": mode = m.mode; state(); detail("/work/acme-api"); return;
    case "select": detail(m.repoId); return;
    case "expand": send({ type: "commitFiles", repoId: m.repoId, sha: m.sha, files: [f("src/limit.go", 40, 0), f("src/server.go", 6, 1)] }); return;
    default: return;
  }
}
(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: CompareWebview) => setTimeout(() => handle(m), 0) });
