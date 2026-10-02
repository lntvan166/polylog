// The browser harness's Repositories page (Polylog Compare tab): a mock host, neutral names.
import type { CRepoRow, ReposHost, ReposWebview } from "../../src/compareProtocol";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "dark";
const BODY_CLASS: Record<string, string> = { dark: "vscode-dark", light: "vscode-light", "hc-dark": "vscode-high-contrast", "hc-light": "vscode-high-contrast vscode-high-contrast-light" };
(document.getElementById("theme") as HTMLLinkElement).href = `themes/${theme}.css`;
document.addEventListener("DOMContentLoaded", () => (document.body.className = BODY_CLASS[theme] ?? BODY_CLASS.dark));

const send = (m: ReposHost) => setTimeout(() => window.postMessage(m, "*"), 30);
let pair = { left: "origin/release-1.4", right: "origin/main" };
let selected = "/work/acme-api";
const rows: CRepoRow[] = [
  { repoId: "/work/acme-api", name: "acme-api", accent: 1, status: "differs", left: 3, right: 1, same: 1, behind: true },
  { repoId: "/work/acme-web", name: "acme-web", accent: 2, status: "differs", left: 5, right: 0, same: 0, behind: false },
  { repoId: "/work/acme-libs", name: "acme-libs", accent: 3, status: "differs", left: 0, right: 2, same: 3, behind: false },
  { repoId: "/work/acme-legacy", name: "acme-legacy", accent: 4, status: "nobase", left: 0, right: 0, same: 0, behind: false },
];
const repos = () => send({ type: "repos", reading: false, summary: "4 repositories differ · =4 on both · 51 identical · 3 missing a branch · in 58 repositories", rows, missing: ["acme-docs", "acme-infra", "acme-ops"], selected, pairKey: `${pair.left}\0${pair.right}` });
const state = () => send({ type: "state", pair, mode: "files", recent: [pair, { left: "origin/release-1.3", right: "origin/prod" }], favorites: ["origin/main"] });

function handle(m: ReposWebview): void {
  console.info("[repos harness]", m);
  switch (m.type) {
    case "ready": state(); repos(); return;
    case "pick": pair = m.pair; state(); repos(); return;
    case "swap": pair = { left: pair.right, right: pair.left }; state(); repos(); return;
    case "select": selected = m.repoId; repos(); return;
    case "wantBranches":
      send({ type: "branches", remotes: ["origin"], names: [{ name: "origin/main", count: 58 }, { name: "main", count: 58 }, { name: "origin/release-1.4", count: 50 }, { name: "origin/release-1.3", count: 50 }, { name: "origin/prod", count: 44 }, { name: "feat/billing", count: 3 }] });
      return;
    case "wantDups": send({ type: "dups", repoId: m.repoId, items: [{ subject: "fix: retry on 503", left: "3f9a2c1".padEnd(40, "0"), right: "b71e0d4".padEnd(40, "0") }] }); return;
    default: return;
  }
}
(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: ReposWebview) => setTimeout(() => handle(m), 0) });
