import assert from "node:assert";
import { findViolations } from "./themeTokens.mjs";

const rules = (text, kind = "css") => findViolations(text, kind).map((v) => v.rule);

{
  assert.deepStrictEqual(rules(".a { color: #fff; }"), ["hex color"]);
  assert.deepStrictEqual(rules(".a { background: rgba(0, 0, 0, 0.5); }"), ["color function"]);
  assert.deepStrictEqual(rules(".a { color: white; }"), ["named color"]);
  assert.deepStrictEqual(rules("@font-face { src: url(x.woff2); }"), ["@font-face"]);
  assert.deepStrictEqual(rules(".a { font-family: Inter, sans-serif; }"), ["font-family not from --vscode-*"]);
  console.log("ok - literal colors and fonts are flagged");
}
{
  assert.deepStrictEqual(rules(".a { color: var(--vscode-foreground); border-left-color: var(--vscode-charts-red); }"), []);
  assert.deepStrictEqual(rules(".a { border: 1px solid transparent; color: currentColor; font: inherit; }"), []);
  assert.deepStrictEqual(rules(".a { font-family: var(--vscode-editor-font-family); }"), []);
  assert.deepStrictEqual(rules("/* #fff white rgb(1,2,3) */ .a { color: inherit; }"), []);
  console.log("ok - theme variables, keywords and comments pass");
}
{
  assert.deepStrictEqual(rules(`el.style.color = "#ff0000";`, "ts"), ["hex color"]);
  assert.deepStrictEqual(rules(`byId("detail"); h("div", { class: "row" });`, "ts"), []);
  console.log("ok - TypeScript is checked for literal colors too");
}
