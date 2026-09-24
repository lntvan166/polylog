import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { findViolations } from "./themeTokens.mjs";

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

let failures = 0;
for (const file of walk("src/webview")) {
  const ext = extname(file);
  if (ext !== ".css" && ext !== ".ts") continue;
  for (const v of findViolations(readFileSync(file, "utf8"), ext === ".css" ? "css" : "ts")) {
    console.error(`${file}:${v.line}: ${v.rule} — use a --vscode-* variable`);
    failures++;
  }
}
if (failures > 0) process.exit(1);
console.log("theme tokens: clean");
