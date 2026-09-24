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

## 12. Amendment: File History mode (2026-09-23, maintainer decision)

Replaces VS Code's "Open Changes with Previous Revision" (one click per revision) with a
browsable history:

- **Entry points:** `polylog.fileHistory` ("Polylog: File History") in the Explorer and editor
  context menus, the editor tab and title bar, and on file nodes of the Changes tree. It
  accepts a `file:` URI, a `polylog:` revision URI (from a Polylog diff) or a Changes node.
- **Mode bar in the Log:** `All commits | File history: <path> · <repo> ×`. The Log lists
  only commits touching that file, via `git log --follow --name-status -z -- <path>` in
  that one repository (pushed to git; paged by `--skip`). Search, author, Me and date still
  apply; the repo pane is dimmed. × or "All commits" returns to the normal log.
- **The diff follows the selection:** selecting a row opens that commit's diff of the file
  (renames resolved per commit) in one preview tab with `preserveFocus`, so ↑/↓ steps
  through revisions; Enter opens it focused. The Changes tree shows the whole commit with
  the file selected. Rows where the file had another name show `— old/path`.

## 13. Amendment: default range, branches, history dates (2026-09-23, maintainer decision)

- **Default range** is the last 24 hours (a saved choice per workspace still wins).
- **Branch box** (filter bar; empty = each repo's current branch), for cases like "show the
  prod branch of every repo". Suggestions list local and remote-tracking branch names
  across repos with how many repos have each, read in the background. A branch applies on
  Enter / pick / leaving the box. Per repo, `git rev-parse --verify --quiet <b>^{commit}`
  (exit code only) decides on the first page whether the repo walks the branch or falls
  back to its current branch; Load More reuses that. The ref is validated (ref-name rules)
  and passed after `--end-of-options`. The footer says "origin/prod in 52 repos · current
  branch in 16"; a row's chip tooltip names its ref. Combines with every other filter and
  with File History.
- **File History dates:** opening it switches the range to All time; closing it restores
  the range the user had before. The menu item reads "Polylog: File History".

## 14. Startup (2026-09-23)

Measured with `npm run perf:startup` (68 repositories, 16,219 commits, one folder, real
VS Code 1.139): open → first rows went from **4.6 s to 0.43 s**.

- Repository discovery no longer waits for vscode.git (it spent ~3.5 s initialising and
  opening 68 repos): the first list comes from a walk of the workspace folders; vscode.git
  starts in the background and its list is adopted once it has been quiet for 1 s, with a
  reload only if the repo set actually differs.
- The "Me" emails and branch suggestions (2 × 68 spawns) start after the first page, once
  per repo set, instead of competing with it.
- The first fetch starts when the view is created, not when its page reports ready.

## 15. Amendment: Changes drawn inside the Log webview (2026-09-24, maintainer decision)

**Superseded the same day (maintainer decision): reverted in aa42ffd.** The native tree's
file-type icons mattered more than removing the header flash, so Polylog keeps two views:
the Log webview and the native Changes tree, with the collapse undone (6c01b9a).

**Why.** Two views in one panel tab give each a header that VS Code collapses on click,
and no API makes a header inert. Undoing the collapse (6c01b9a) still flashes for
0.2–0.3 s. With one view in the container there is no header at all, so nothing can
collapse or flash. The maintainer chose this over moving Changes to the side bar, and
accepted losing the file-icon theme's icons in the tree.

**Layout.** The Polylog panel tab holds one webview view, `polylog.log`. It has three
panes: Repositories | Log | Changes. Two splitters separate them, with the same drag and
keyboard behaviour as today's (`attachSplitter`). The Changes width is saved per user
like the Repositories width, starts at 450 px, is at least 200 px, and always leaves the
Log 300 px. Below a 720 px panel width, Changes stacks under the Log instead.
Group by Repository and its title-bar toggle are unchanged; the actions now sit in the
panel tab's own toolbar, as happens for any single-view container.

**What the Changes pane shows.** The same content as today's tree:
- A commit header: subject, then short SHA · author · relative time.
- The full commit message.
- The file tree, built by the existing pure `describeChanges` in the host and posted as
  data. The webview gets no git logic.
- Folder rows fold with a chevron. File rows show the name in its git status color, a
  `+A −D` count and a status badge (`A`/`M`/`D`/`R`/`C`/`T`). Colors come from
  `--vscode-gitDecoration-*`.
- No file-type icons: there is no icon-theme API for webviews, and bundling an icon font
  breaks constraint 2.
- Loading, error and "select a commit" states.
- In File History, the history's file is selected and scrolled into view.

**Interaction.**
- Click a file, or press Enter on it, to open its diff in the editor above (host
  `openDiff`, as today).
- The tree is a separate tab stop: `role="tree"`, with `aria-activedescendant` like the
  Log.
  - ↑/↓ move.
  - ←/→ fold or unfold, or go to the parent.
  - Home/End.
- Focus in the tree doesn't change the Log's selection.
- Right-click uses VS Code's native context menu, via `webview/context` contributions and
  `data-vscode-context`:
  - on the commit header: Copy SHA and Copy Message;
  - on a file: Polylog: File History.
  - The existing commands receive the row's context.

**Removed.**
- The `polylog.changes` tree view and `ChangesTree`'s `TreeDataProvider` and
  `FileDecorationProvider` roles.
- The `view/item/context` menus.
- `keepExpanded` (from 6c01b9a); `PaneWidth` stays.
- The host keeps the per-commit state (loading, files, message, focusPath) in a plain
  model and posts it to the webview on each change.

**Unchanged.** Git usage, filters, File History, the diff documents (`polylog:` scheme),
and every constraint. Colors are still only `--vscode-*` variables, and high contrast
uses outlines.

**Testing.**
- Unit: the described tree becomes pure webview view-models: flattening for keyboard
  navigation, fold state kept across re-renders by node id, and the context-menu payload.
- Integration: the `changes` snapshot keeps its shape (`items`, `focused`, `message`), now
  read from the host model. Tests that asserted native tree internals (`schemes`,
  `decorations`) assert the posted badge and color instead.
- Harness: the Changes pane in all four theme shims.
- A real VS Code check on Xvfb: no view headers; right-click menus.

## 16. Amendment: Open File on a Polylog diff (2026-09-24, maintainer request)

A Polylog diff shows two revisions, so VS Code's own "Open File" has no workspace file to
go to. `polylog.openWorkingFile` ("Open File", `$(go-to-file)`) fills that gap:
- It appears in the title bar of any `polylog:` editor, and on a file's right-click in the
  Changes tree.
- It opens the working-tree file for the revision, as a normal (non-preview) editor, at the
  line the diff's cursor was on.
- The file must lie inside a repository of this workspace (`revisionUri.workingFile`
  refuses `..` and unknown roots).
- A file that no longer exists in the workspace (deleted or renamed since) gets a message
  instead of an error.

## 17. Amendment: VS Code Elements checkboxes, and Me as an input toggle (2026-09-24, maintainer decision)

Chosen from a side-by-side comparison (current CSS, VS Code Elements, a refined custom
CSS) in all four theme kinds:
- The Repositories pane's checkboxes are `<vscode-checkbox>` from
  [VS Code Elements](https://vscode-elements.github.io/) (`@vscode-elements/elements`,
  MIT, pinned 2.5.1). It is a web component, not a framework (CLAUDE.md "no framework in
  the webview" holds), and it draws VS Code's own box, tick and hover from the theme's
  `--vscode-checkbox-*` and `--vscode-settings-checkbox*` variables. Only the checkbox is
  imported. The minified webview grows from 19.5 KB to 50 KB (the checkbox plus Lit).
  Its licenses ship in `ThirdPartyNotices.txt`.
- The box stays presentational (`aria-hidden`, `tabindex=-1`): the row is the listbox
  option and owns the click and the keyboard. A click on the box still ticks or unticks;
  a click on the name still shows only that repository.
- "Me" moves inside the Author box as an input-option toggle, like the Aa / ab / .*
  toggles in VS Code's search, using `--vscode-inputOption-*`.
- Everything else in the left view is unchanged.
