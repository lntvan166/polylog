import type { HtmlOptions } from "../html";

/** Repositories' markup (Polylog Compare tab); the extension host and the browser harness both render it. */
export function renderReposHtml(o: HtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; img-src ${o.cspSource}; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${o.styleUri}">
<title>Repositories</title>
</head>
<body>
<div id="repos" class="repos">
  <div class="cbar" role="toolbar" aria-label="Compare">
    <div class="cbar-pair">
      <button id="branch-left" class="branch-box left" aria-haspopup="dialog" title="The branch to merge from"><span class="side-mark" aria-hidden="true">◀</span><span id="name-left" class="branch-name"></span><span class="caret" aria-hidden="true">▾</span></button>
      <button id="swap" class="icon-button" title="Swap sides" aria-label="Swap sides">⇄</button>
      <button id="branch-right" class="branch-box right" aria-haspopup="dialog" title="The branch it goes into"><span class="side-mark" aria-hidden="true">▶</span><span id="name-right" class="branch-name"></span><span class="caret" aria-hidden="true">▾</span></button>
    </div>
    <div class="cbar-show">
      <span class="seg" role="group" aria-label="Show"><button id="mode-files" aria-pressed="true">Files</button><button id="mode-commits" aria-pressed="false">Commits</button></span>
      <button id="refresh" class="icon-button" title="Refresh" aria-label="Refresh">↻</button>
    </div>
  </div>
  <div id="summary" class="csummary" aria-live="polite"></div>
  <div id="message" class="cmessage" hidden></div>
  <div id="repo-list" class="repo-list" role="listbox" tabindex="0" aria-label="Repositories whose files differ"></div>
  <details id="missing" class="missing" hidden><summary id="missing-title"></summary><ul id="missing-list"></ul></details>
  <div id="picker" class="picker" role="dialog" aria-label="Pick a branch" hidden>
    <input id="picker-search" type="search" placeholder="Search branches" aria-label="Search branches" autocomplete="off" spellcheck="false">
    <div id="picker-items" class="picker-items" role="listbox" aria-label="Branches"></div>
  </div>
</div>
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>`;
}
