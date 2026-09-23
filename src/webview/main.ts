import "./styles.css";
import type { HostMessage, WebviewMessage } from "../protocol";
import { byId, clear, h } from "./dom";

const vscode = acquireVsCodeApi();
const rows = byId("rows");

window.addEventListener("message", (e: MessageEvent<HostMessage>) => {
  const m = e.data;
  if (m.type !== "page") return;
  if (!m.append) clear(rows);
  for (const c of m.rows) rows.append(h("div", {}, [c.subject]));
});

vscode.postMessage({ type: "ready" } satisfies WebviewMessage);
