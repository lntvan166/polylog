// Dev-only stand-in for the extension host. It answers the webview's messages
// with mock data so the real webview bundle runs in a plain browser. Filtering
// mock data in JS here is fine: this is a harness, not the product.
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
let matched: Commit[] = [];
let offset = 0;

function send(m: HostMessage, delay = latency): void {
  setTimeout(() => window.postMessage(m, "*"), delay);
}

function matching(f: FilterState): Commit[] {
  const text = f.text.trim().toLowerCase();
  const author = f.author.trim().toLowerCase();
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

function reload(): void {
  send({ type: "loading" }, 0);
  matched = matching(filter);
  offset = 0;
  page(false);
}

function handle(m: WebviewMessage): void {
  switch (m.type) {
    case "ready": send({ type: "init", repos, filter, me: "dana@example.com", layout: { repoPaneWidth: 190, groupByRepo: params.get("repos") !== "off" } }, 0); reload(); return;
    case "layout": console.info("[harness] layout", m); return;
    case "filter": filter = m.filter; reload(); return;
    case "refresh": reload(); return;
    case "loadMore": page(true); return;
    case "select": case "openFirst": console.info(`[harness] ${m.type}`, m); return;
    case "openSettings": console.info("[harness] openSettings"); return;
  }
}

(window as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi = () => ({
  postMessage: (m: unknown) => handle(m as WebviewMessage),
  getState: () => undefined,
  setState: () => undefined,
});
