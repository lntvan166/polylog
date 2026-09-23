# Polylog — Panel View and Native Changes Tree

**Date:** 2026-09-23
**Status:** approved in conversation, pending written-spec review
**Amends:** `2026-09-23-polylog-design.md` §4 "Layout" (editor tab → bottom panel) and §3
"Viewing a commit's changes" (file list → native tree). Everything else in that spec stands:
no index, filters pushed into `git log`, theme variables only, neutral fixtures.

---

## 1. What Changes and Why

v1 opened Polylog as a webview in an **editor tab**, with the changed files drawn inside the
webview. In use, that competes with the files being reviewed: opening a diff pushes the log
into the background, and the webview file list is not a native tree.

The maintainer's direction (modelled on GitCharm's panel log and the JetBrains VCS Log):

- Polylog is a **tab in the bottom panel**, beside Terminal.
- The commit list stays a webview (it virtualizes 16k rows).
- Changed files are a **native VS Code tree**.
- Clicking a file opens the native diff **in the editor area above**; the panel stays put.

## 2. Layout

```
┌ editor area ─────────────────────────────────────────────────────────────┐
│  client.ts │ upload.go (1596c39) ↔      ← diffs open here                 │
├ panel: Problems  Output  Terminal  [Polylog] ────────────────────────────┤
│ LOG (webview)                                  │ CHANGES (native tree)    │
│ [search]            [All repositories] [30d] ⟳ │ ▾ ◉ feat: add retry…     │
│ acme-api  feat: add retry to uploader  rin 2h  │     1596c39 · rin · 2h   │
│ acme-web  fix: guard nil response     dana 3h  │   ▾ 📁 internal/upload 2 │
│ …                                              │       upload.go  +42 −7  │
│ Load More        Newest first by commit date   │       upload_test.go +88 │
└──────────────────────────────────────────────────────────────────────────┘
```

Both views live in one panel view container, so VS Code lays them out side by side and the
user can resize, collapse or drag either one elsewhere (sidebar, secondary sidebar).

## 3. Contributions (`package.json`)

| Contribution | Value |
|---|---|
| `viewsContainers.panel` | `{ id: "polylog", title: "Polylog", icon: "media/polylog.svg" }` |
| `views.polylog[0]` | `{ type: "webview", id: "polylog.log", name: "Log" }` |
| `views.polylog[1]` | `{ id: "polylog.changes", name: "Changes" }` |
| `commands` | `polylog.open` (palette: "Polylog: Open Merged Log"), `polylog.openDiff`, `polylog.copySha`, `polylog.copyMessage` |
| `menus.view/item/context` | Copy SHA / Copy Message when `view == polylog.changes && viewItem == commit` |
| `menus.commandPalette` | hide `polylog.openDiff`, `polylog.copySha`, `polylog.copyMessage` |
| `activationEvents` | `onCommand:polylog.open`, `onView:polylog.log`, `onView:polylog.changes` |

`media/polylog.svg` is a monochrome icon drawn with `currentColor`, so it follows the theme.
It is added to the `.vscodeignore` allowlist.

`polylog.open` runs `polylog.log.focus`, which opens the panel and shows the Log.

## 4. Log View (webview)

- Registered with `registerWebviewViewProvider("polylog.log", …, { webviewOptions: { retainContextWhenHidden: true } })`,
  so switching to Terminal and back keeps selection and scroll.
- Same content as v1 minus the detail pane: filter bar, one-line rows with repo chips,
  notices, empty states, Load More, the best-effort ordering note. The list fills the view's
  full width.
- `Enter` posts `{ type: "openFirst", repoId, sha }`; the host opens the first non-binary file
  of that commit (waiting for its file list if still loading).
- The webview no longer receives a `detail` message.

## 5. Changes View (native tree)

A `TreeDataProvider` fed by the host. Nodes:

| Node | Label | Description | Icon | Tooltip | Other |
|---|---|---|---|---|---|
| Commit (root) | subject | `1596c39 · rin · 2h ago` | `$(git-commit)` | full message, then `author <email> · YYYY-MM-DD HH:MM · repo` | `contextValue: "commit"`, expanded |
| Folder | name (single-child chains compressed: `internal/upload`) | file count | theme folder icon (via `resourceUri`) | folder path | expanded |
| File | base name | `+42 −7`; renamed: `← old/path  +0 −0`; binary: `binary` | theme file icon (via `resourceUri`) | repo-relative path | `command: polylog.openDiff` unless binary |

The tree reuses v1's pure `fileTree()` (moved from `src/webview/view.ts` to `src/fileTree.ts`).
All labels, descriptions and tooltip text are produced by a pure module (`changesModel.ts`) so
they are unit-tested without VS Code.

**States**, shown through the native `TreeView.message` with an empty tree:

- No selection: "Select a commit in the Log to see its changed files."
- Loading: "Loading changed files…" (the commit node is already shown)
- Failure: "Could not read this commit: <git's first stderr line>"
- No files: the commit node alone, message "This commit changes no files."

## 6. Data Flow

1. The webview posts `select { repoId, sha }`.
2. The host validates `isSha`, finds the commit among the rows it holds, and pushes the commit
   node to the tree at once (Loading state).
3. The host aborts any previous detail spawn, runs `git show` (`showArgs`), `parseShow` → files and message.
4. The tree is updated; stale results for a commit no longer selected are dropped.
5. A file click runs `polylog.openDiff { repoId, sha, parent, path, oldPath }`. The same
   validation as v1 applies (`isSha` on sha and parent), then `vscode.diff` opens in the active
   editor group, which is always in the editor area because a panel view is not an editor group.

## 7. Modules

| Module | Change |
|---|---|
| `src/logView.ts` | New `WebviewViewProvider`; takes over `logPanel.ts` (filters, debounce, cancellation, paging, persistence) minus the detail posting |
| `src/changesModel.ts` | New, pure: `{commit, repoName, files, message, status}` → node descriptors and view message |
| `src/changesTree.ts` | New, thin `TreeDataProvider` over `changesModel` |
| `src/fileTree.ts` | Moved from `src/webview/view.ts` |
| `src/extension.ts` | Registers both views and the four commands |
| `src/protocol.ts` | Drop `HostMessage.detail` and `WebviewMessage.openFile`; add `openFirst` |
| `src/webview/detail.ts`, `src/logPanel.ts` | Removed |
| `src/webview/*`, `styles.css` | Detail pane removed; list takes full width |

## 8. Testing

- **Unit:**
  - `fileTree` tests move with the module.
  - New `changesModel.test.ts` covers:
    - commit node text and tooltip, including a multi-line body and the author email;
    - `+/−` descriptions, rename, binary (no command);
    - each state message.
- **Integration:** rewritten against the panel.
  - `polylog.open` focuses the Log.
  - Rows merge across three repos, search and subset narrow them, and the snapshot seam still works.
  - Selecting a commit fills the Changes tree (commit node plus files, read through a test seam).
  - `polylog.openDiff` opens a diff whose tab is in an editor group.
  - A non-SHA ref is rejected.
  - Hiding and re-showing the panel does not reload the webview (`readyCount`).
- **Harness:** unchanged purpose. It renders the Log view in four themes. The native tree needs no harness: VS Code themes it.

## 9. Out of Scope

A staged/unstaged split, a commit graph, per-file history, blame. None serves the merged log.

## 10. Amendment: Group by Repository (2026-09-23, maintainer decision)

The panel gains a third, native **Repositories** view on the left, so it reads
Repositories | Log | Changes, like the JetBrains VCS Log. This reverses the v1 spec's
rejection of a permanent repo sidebar.

- "All repositories" then every repo, each name colored with its Log chip's chart hue.
- Clicking (Ctrl/Cmd for several) sets the Log's repo filter, the same filter as the
  dropdown and still passed to git; changing the dropdown moves the tree's selection.
- **Group by Repository** is on by default; the Log's title bar toggles it
  (`polylog.showRepos` / `polylog.hideRepos`, context key `polylog.hideRepos`, persisted).

## 11. Amendment: Repositories pane inside the Log webview (2026-09-23, maintainer decision)

Supersedes §10's native Repositories view. Native views in one container can be collapsed
by clicking their title (losing the user's size), and extensions cannot style the dividers
between them, so the Repositories pane moved into the Log webview:

- Log view = Repositories pane | draggable divider | Log. The divider is a theme line
  (`panel.border`) that lights with `sash.hoverBorder`; drag or ←/→ resizes; the width is
  saved (`globalState`, default 190px, clamped 120–480px, leaving ≥300px for the Log).
- The pane: a search box that narrows the repo list, "All repositories" with the count, and
  a checkbox plus chip-colored dot per repo. Click a name = only that repo; checkbox,
  Space or Ctrl/Cmd-click = toggle; Enter = only. It edits the same repo filter (still
  passed to git); the filter bar's repo dropdown is removed.
- Changes stays a native tree (file-icon theme + git colors). View `initialSize`: Log 1100,
  Changes 450, matching the maintainer's reference layout.
- The webview paints `panel.background`, the same surface as the native tree beside it.
- Group by Repository now shows or hides this pane.
