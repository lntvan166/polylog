// Dev-only stand-in for the extension host. It answers the webview's messages
// with mock data so the real webview bundle runs in a plain browser. Filtering
// mock data in JS here is fine: this is a harness, not the product.
import { describeChanges } from "../../src/changesModel";
import { DEFAULT_FILTER, type FilterState } from "../../src/filterModel";
import type { HostMessage, WebviewMessage } from "../../src/protocol";
import type { Commit } from "../../src/types";
import { mockCommits, mockRepos, NOW } from "./mock";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "dark";
const scenario = params.get("state") ?? "default";
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

const PAGE = 200;
const latency = scenario === "slow" ? 1500 : 25;
const repos = mockRepos(scenario);
const all = mockCommits(repos, scenario);
let filter: FilterState = DEFAULT_FILTER;
let history: { repoName: string; path: string } | null = params.get("history") ? { repoName: "acme-web", path: params.get("history")! } : null;
let matched: Commit[] = [];
let offset = 0;

function send(m: HostMessage, delay = latency): void {
  setTimeout(() => window.postMessage(m, "*"), delay);
}

function matching(f: FilterState): Commit[] {
  const text = f.text.trim().toLowerCase();
  const author = f.mine ? "dana@example.com" : f.author.trim().toLowerCase();
  const ids = f.repoIds === null ? null : new Set(f.repoIds);
  const span = { "24h": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400 } as Record<string, number>;
  const since = span[f.date] !== undefined ? NOW - span[f.date] : f.date === "custom" && f.from ? Date.parse(`${f.from}T00:00:00`) / 1000 : -Infinity;
  const until = f.date === "custom" && f.to ? Date.parse(`${f.to}T23:59:59`) / 1000 : Infinity;
  return all.filter((c) =>
    (!text || c.subject.toLowerCase().includes(text)) && (!author || `${c.author} <${c.email}>`.toLowerCase().includes(author)) && (!ids || ids.has(c.repoId)) && c.time >= since && c.time <= until);
}

function page(append: boolean): void {
  const rows = matched.slice(offset, offset + PAGE);
  offset += rows.length;
  const failures = scenario === "failure"
    ? [{ repoId: "/work/acme-libs", name: "acme-libs", reason: "shallow clone: history is incomplete" }]
    : [];
  send({ type: "page", rows, append, failures, done: offset >= matched.length, now: NOW });
}

/** A plausible file list per commit, so the Changes pane has something to draw. */
function changesFor(repoId: string, sha: string): void {
  const commit = all.find((c) => c.repoId === repoId && c.sha === sha);
  if (!commit) return;
  const n = parseInt(sha.slice(0, 4), 16);
  const files = [
    { path: "src/checkout/PaymentStep.tsx", added: 11, deleted: 1, status: "M" as const },
    { path: "src/checkout/SavedCards.tsx", added: 25, deleted: 0, status: "A" as const },
    { path: "src/api/client.ts", added: 2, deleted: 0, status: "M" as const },
    { path: "src/legacy/OldCards.tsx", added: 0, deleted: 40, status: "D" as const },
    { path: "docs/cards.md", oldPath: "docs/saved-cards.md", added: 3, deleted: 1, status: "R" as const },
    { path: "assets/logo.png", added: null, deleted: null, status: "M" as const },
  ].slice(0, 2 + (n % 5));
  const state = { commit, repoRoot: repoId, repoName: repos.find((r) => r.id === repoId)?.name ?? repoId, status: "ready" as const, files, message: `${commit.subject}\n\nWhy: customers asked to reuse a card.\nRefs ACME-142.`, focusPath: history?.path };
  const d = describeChanges(state, NOW);
  send({ type: "changes", view: { message: d.message, roots: d.roots, focusPath: history?.path, body: "Why: customers asked to reuse a card.\nRefs ACME-142." } });
}

function reload(): void {
  send({ type: "loading" }, 0);
  matched = matching(filter);
  offset = 0;
  page(false);
}

function handle(m: WebviewMessage): void {
  switch (m.type) {
    case "ready": send({ type: "changes", view: { message: "Select a commit in the Log to see its changed files.", roots: [], focusPath: undefined, body: "" } }, 0); send({ type: "init", repos, filter, hasMe: true, layout: { repoPaneWidth: 190, changesPaneWidth: 450, groupByRepo: params.get("repos") !== "off" }, history, branches: [{ name: "main", count: 3 }, { name: "origin/main", count: 3 }, { name: "origin/prod", count: 2 }] }, 0); reload(); return;
    case "exitHistory": history = null; send({ type: "init", repos, filter, hasMe: true, layout: { repoPaneWidth: 190, changesPaneWidth: 450, groupByRepo: true }, history, branches: [] }, 0); reload(); return;
    case "layout": console.info("[harness] layout", m); return;
    case "filter": filter = m.filter; reload(); return;
    case "refresh": reload(); return;
    case "loadMore": page(true); return;
    case "select": changesFor(m.repoId, m.sha); return;
    case "openFirst": case "openFile": console.info(`[harness] ${m.type}`, m); return;
    case "openSettings": console.info("[harness] openSettings"); return;
  }
}

(window as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi = () => ({
  postMessage: (m: unknown) => handle(m as WebviewMessage),
  getState: () => undefined,
  setState: () => undefined,
});
