import "./compare.css";
import type { CompareWebview } from "../../compareProtocol";

declare function acquireVsCodeApi(): { postMessage(m: CompareWebview): void };
const vscodeApi = acquireVsCodeApi();
vscodeApi.postMessage({ type: "ready" });
