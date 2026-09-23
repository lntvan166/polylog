# Polylog

**One git log across every repository in your workspace.**

Search commits by message across all of your repos at once, and see the changed files
without switching repositories.

---

## Status

**Implemented, not yet released.** The design is in
[`docs/superpowers/specs/2026-09-23-polylog-design.md`](docs/superpowers/specs/2026-09-23-polylog-design.md).

## The problem

Multi-root and sibling-repo workspaces are ordinary — polyrepo services, a vendored library
beside its consumer, a docs repo next to the product. Every VS Code git extension handles
them the same way: a repository **picker**. You read one repo's history at a time.

So the question "which repos did this ticket touch?" means opening each repository in turn.

JetBrains IDEs merge all VCS roots into one filterable log. Polylog brings that single
capability to VS Code.

## How it works

`git log` runs once per repository with your filters passed straight through as flags, and
the results are merged by date. There is no index and no cache — measured across a
68-repository, 16,000-commit workspace, the full fan-out takes **25 ms**, so there is
nothing for a database to improve on.

## Using it

Run **Polylog: Open Merged Log** from the Command Palette. Polylog opens as a tab in the
bottom panel, next to Terminal: the **Log** on the left, the native **Changes** tree on the
right. Clicking a file opens its diff in the editor area above. Right-click the commit in
Changes to copy its SHA or message.

The **Repositories** pane on the left (Group by Repository, on by default; toggle it from the
Log's title bar) filters the Log to the repos you pick. Filters: message search, author
(with **Me**), repositories, and date range.

**File history:** right-click a file (Explorer, editor, tab, or a file in Changes) →
**Polylog: File History**. The Log shows only that file's commits, following renames, and
the diff follows your selection, so ↑/↓ steps through its revisions.

| Key | Action |
|---|---|
| `↑` / `↓`, `Home` / `End`, `PageUp` / `PageDown` | Move the selection; the changed files follow |
| `Enter` | Open the selected commit's first changed file in the editor area |
| `/` or `Ctrl/Cmd+F` | Search commit messages |
| `Esc` | Clear the search, then return to the list |

Filters: message search (literal, case-insensitive), repositories, and date range.
Commits are merged newest first by committer date. Unrelated repositories share no
history, so a rebase or a skewed clock can place a commit out of order.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `polylog.pageSize` | 200 | Commits fetched per repository per page |
| `polylog.maxConcurrency` | 16 | Parallel `git log` processes |
| `polylog.scanDepth` | 2 | Fallback discovery depth when the Git extension reports no repositories |
| `polylog.excludeRepos` | `[]` | Glob patterns for repositories to leave out |

## Development

    npm install
    npm run compile && npm test          # lint/typecheck: npm run lint, npm run typecheck
    npm run harness                      # webview in a browser: http://localhost:5178/gallery.html
    xvfb-run -a npm run test:integration # real VS Code, three fixture repos

The harness runs the real webview with mock data and theme variables for dark, light,
and both high-contrast themes (`?theme=…&state=default|many|empty|norepos|failure|slow`).

## License

MIT
