export interface HtmlOptions {
  cspSource: string;
  nonce: string;
  scriptUri: string;
  styleUri: string;
}

// Inline SVG, not a codicon: the codicon font would be a bundled webfont.
const REFRESH_ICON =
  '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
  '<path fill="none" stroke="currentColor" stroke-width="1.3" d="M13 8a5 5 0 1 1-1.46-3.54"/>' +
  '<path fill="currentColor" d="M13.5 2v4h-4z"/></svg>';

/** The one markup source for both the extension host and the browser harness. */
export function renderHtml(o: HtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${o.cspSource}; img-src ${o.cspSource}; script-src 'nonce-${o.nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${o.styleUri}">
<title>Polylog</title>
</head>
<body>
<div class="app">
  <form id="filters" class="filters" role="search" aria-label="Filter commits">
    <input id="search" class="search" type="search" placeholder="Search commit messages" aria-label="Search commit messages" autocomplete="off" spellcheck="false">
    <div class="repo-picker">
      <button id="repo-button" class="dropdown" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="repo-menu">All repositories</button>
      <div id="repo-menu" class="menu" hidden>
        <input id="repo-search" type="search" placeholder="Filter repositories" aria-label="Filter repositories" autocomplete="off" spellcheck="false">
        <div class="menu-actions">
          <button id="repo-all" class="link" type="button">All</button>
          <button id="repo-none" class="link" type="button">None</button>
        </div>
        <div id="repo-list" class="repo-list" role="group" aria-label="Repositories"></div>
      </div>
    </div>
    <select id="date" aria-label="Date range">
      <option value="24h">Last 24 hours</option>
      <option value="7d">Last 7 days</option>
      <option value="30d">Last 30 days</option>
      <option value="all">All time</option>
      <option value="custom">Custom range</option>
    </select>
    <span id="custom-range" class="custom-range" hidden>
      <input id="from" type="date" aria-label="From date">
      <span aria-hidden="true">–</span>
      <input id="to" type="date" aria-label="To date">
    </span>
    <button id="refresh" class="icon-button" type="button" aria-label="Refresh" title="Refresh">${REFRESH_ICON}</button>
  </form>
  <div id="notices" class="notices"></div>
  <main class="split">
    <section class="list-pane" aria-label="Commits">
      <div id="list" class="list" role="grid" aria-label="Commits" aria-rowcount="0" tabindex="0">
        <div id="rows" class="rows" role="rowgroup"></div>
      </div>
      <div id="empty" class="empty" hidden></div>
    </section>
    <aside id="detail" class="detail" aria-label="Changed files"></aside>
  </main>
  <footer class="footer">
    <button id="more" class="secondary" type="button" hidden>Load More</button>
    <span class="note" title="Commits in different repositories share no history, so they are merged by committer date. A rebase or a skewed clock can place a commit out of order.">Newest first by commit date</span>
    <span id="count" class="count" aria-live="polite"></span>
  </footer>
</div>
<script nonce="${o.nonce}" src="${o.scriptUri}"></script>
</body>
</html>
`;
}
