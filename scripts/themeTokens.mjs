// CLAUDE.md constraint 2: every color and font in the webview comes from a
// --vscode-* variable. This flags literals so a hard-coded color cannot slip in.
const NAMED = ["white", "black", "red", "green", "blue", "gray", "grey", "silver", "orange", "yellow", "purple", "pink", "navy", "teal", "maroon", "olive", "lime", "aqua", "fuchsia", "brown"];
// Theme variables that exist but cannot carry a color: VS Code registers charts.orange as
// an alias of minimap.findMatchHighlight, which is translucent in light and dark themes and
// unset in high contrast. The harness shims define them opaque, so only this rule sees it.
const UNRELIABLE = ["--vscode-charts-orange"];
const NAMED_RE = new RegExp(`:[^;]*(?<![-\\w])(${NAMED.join("|")})(?![-\\w])`, "i");

export function findViolations(text, kind) {
  const out = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  code.split("\n").forEach((raw, i) => {
    const line = kind === "ts" ? raw.replace(/(^|\s)\/\/.*$/, "") : raw;
    const hit = (rule) => out.push({ line: i + 1, rule });
    if (/#[0-9a-fA-F]{3,8}\b/.test(line)) hit("hex color");
    if (/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i.test(line)) hit("color function");
    for (const t of UNRELIABLE) if (new RegExp(`${t}(?![-\\w])`).test(line)) hit(`unreliable token ${t}`);
    if (kind !== "css") return;
    if (/@font-face/i.test(line)) hit("@font-face");
    const ff = /font-family\s*:\s*([^;]+)/i.exec(line);
    if (ff && !/^(var\(--vscode-|inherit\b)/.test(ff[1].trim())) hit("font-family not from --vscode-*");
    if (!/^\s*--/.test(line) && NAMED_RE.test(line)) hit("named color");
  });
  return out;
}
