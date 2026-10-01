# Uncommitted View, Review Switch and All Files — Design

Project 1 of 3 (then Compare Branches, then a UI pass with impeccable). Status: approved in
brainstorming on 2026-10-01; the interactive demo (brainstorm companion, `demo-project1-v6.html`)
is the visual reference. Part names follow the UI Map (`dev/ui-map/index.html`, `/ui-map`).

## 1. Goal

Uncommitted work gets its own place in the Polylog panel, with what a person needs before a
commit: see every repository's uncommitted files, stage, unstage, discard and commit. The Log's
Commit list shows only commits. The Changes view can show a commit's whole file tree.

Not in this project: Compare Branches (project 2), a visual redesign of existing parts (project 3).

## 2. The Polylog panel and its views

The Polylog panel holds three views, left to right: **Log view**, **Changes view**,
**Uncommitted view**.

| # | Rule |
|---|------|
| 1 | First install: all three shown; the Uncommitted view starts **collapsed** (`"visibility": "collapsed"` in `package.json`). Log and Changes start open. |
| 2 | Show or hide a view through VS Code's own view menu (right-click a view header, or the panel's `⋯`). VS Code remembers it. |
| 3 | Clicking a view header collapses it to its title; it stays so until clicked again. |
| 4 | **Polylog never opens, expands or reveals a view by itself.** `polylog.keepViewsExpanded`, `UndoCollapse` (`src/keepExpanded.ts`) and their tests are removed. |
| 5 | Changes view hidden or collapsed: it still follows the selected commit and shows it when opened. |
| 6 | Uncommitted view hidden or collapsed: it renders nothing. The data it shows is still kept current for the Log's switch badge (section 3.2), so opening it shows current rows at once. |
| 7 | Log hidden: the Changes view keeps the last commit; the Repo List ticks stay as they were. |
| 8 | Commands the user runs open the view they name: Polylog: Open Merged Log, Polylog: Focus Uncommitted, File History. |

## 3. Log view

### 3.1 What leaves

- From the **Log toolbar**: the eye (Show/Hide Uncommitted) and the Review Uncommitted checklist.
  The toolbar keeps Group by Repository, Fetch All and `⋯`.
- **Uncommitted rows** pinned above the commits (`shownRows`'s pinned part) and everything that
  posts them (`pinned` message, `withPinned`).
- The **Mode bar** for Review Uncommitted (`mode-review`, `reviewLabel`). The Mode bar stays for
  File History.
- Setting `polylog.showUncommitted`; commands `polylog.showUncommitted`, `polylog.hideUncommitted`,
  `polylog.reviewUncommitted`; context key `polylog.showUncommitted`. A user who had the setting
  on loses nothing: VS Code ignores unknown settings, and the Uncommitted view is in the panel.

### 3.2 Commits | Uncommitted switch

A segmented switch at the top of the Log view, above the Filter bar: **Commits** (the default,
today's Log) and **Uncommitted N**.

- **N** is the number of distinct uncommitted files across the ticked repositories, under the
  Path box. No number until it is known; never "0" (the badge is simply absent).
- **When it is read:** in the background right after the first page of commits, like the Me
  emails and the ↓/↑ counts (one `git status` per ticked repository; dirty ones add the
  numstat reads, section 5.2). It never delays the first page. From then on saves and VS Code
  Git's reports keep it current (the existing per-repository reads), so the count and the
  Uncommitted view always agree: they read one store (section 6).
- The switch is a `role="tablist"`; ←/→ move between the two; the choice is per window (not
  persisted: a reload opens on Commits).

**Uncommitted side of the Log:**

- Totals at the right of the switch: "3 repositories · +24 −5".
- Filter bar: the Path box only (Search, Author, Branch and Date range do not apply to
  uncommitted work). The Repo List ticks apply.
- One **Uncommitted list row** per ticked repository with uncommitted work, most recently edited
  first:
  - its repo chip;
  - "3 files · src/app.ts, src/new.ts, notes.md" (as many names as fit, cut with "…");
  - a change meter: a 4 px bar split by count into new, modified and deleted files (`--vscode-gitDecoration-*` colors);
  - tags: "N staged" or "all staged", "N new";
  - "edited 2m ago": the newest modification time among its changed files (section 5.4).
- Clicking a row fills the Changes view with that repository's uncommitted files, review only:
  repo header "acme-web · 3 files · not committed", files under folders, "· staged" and "new"
  as today; a click opens the diff (section 4.4). A note at the bottom of the Changes view points to
  the Uncommitted view for staging.
- Empty: "Nothing uncommitted in the ticked repositories."
- Commits brings back the Commit list with the filters exactly as they were.

### 3.3 Freshness while on Commits

Unchanged from 0.5.0: the commit page never waits for uncommitted reads; a save re-reads only its
repository; a date or text change does not re-read working trees of repositories VS Code's Git
reports on.

## 4. Uncommitted view

### 4.1 Rows

- **Uncommitted repo row**: dot in the repo's color (`ThemeIcon` with its `charts.*` color),
  name, "3 files". Ticked repositories with uncommitted work only, in Repo List order.
- **Staged group** and **Changes group** under it, each only when non-empty, with a count badge.
  A file staged and then edited again appears in both.
- **Uncommitted file row**: under folders (the Changes view's tree shape), with +/− counts, the
  A/M/D/R badge, "new" for untracked files. Untracked files sit in Changes.
- Empty: "No uncommitted changes in the ticked repositories."

### 4.2 Actions (inline on hover, and in the right-click menu)

| On | Action | How |
|---|---|---|
| Repo row | ✓ Commit… | section 4.3 |
| Repo row | right-click: the Repo menu (Pull, Show Only…, Open Folder…) | existing commands |
| Staged group / file | − Unstage | vscode.git `repository.revert(paths)` |
| Changes group / file | + Stage | vscode.git `repository.add(paths)` |
| Changes group / file | ↶ Discard | confirmation (below), then vscode.git `repository.clean(paths)` |
| File | click: Open Diff; right-click: Open File, File History | section 4.4 |
| View toolbar | Refresh, Collapse All | |

**Discard confirmation** (modal, `showWarningMessage`): "Discard changes in "src/app.ts"?" /
"Discard changes in 3 files in acme-web?", detail "This can't be undone.", plus " This deletes
the new file." / " 2 new files will be deleted." when untracked files are included. Buttons:
Discard File / Discard All, and Cancel. Cancel changes nothing.

**Repositories VS Code's Git does not have open** (deeper than its scan depth, Git disabled):
listed, review only. Their repo row's tooltip says "Staging needs VS Code's Git to have this
repository open." No Stage, Unstage, Discard or Commit buttons (`contextValue` without them).

After every action the repository is read again (one repository, section 5).

### 4.3 Commit…

1. With staged files: VS Code's input box, prompt "Commit message for acme-web", placeholder
   "Message (N files staged)". Cancel or an empty message: nothing happens.
2. With nothing staged: follow `git.enableSmartCommit` (true: commit all); otherwise ask, as
   VS Code does: "There are no staged changes in acme-web. Stage all changes and commit them?"
   (Stage All and Commit / Cancel), then the message box.
3. Commit through vscode.git `repository.commit(message, { all })`. A failure (a hook, an empty
   index) is shown in git's own words: `Polylog could not commit acme-web: <message>.`
4. Afterwards: the Log reloads (the new commit at the top), the repository is read again.

### 4.4 Which diff a file opens (as Source Control)

| Row | Left | Right |
|---|---|---|
| Staged, modified | last commit (`HEAD`) | index (staged version) |
| Staged, added | empty | index |
| Changes, modified, also staged | index | the workspace file (editable) |
| Changes, modified, not staged | last commit | the workspace file |
| Changes, untracked | empty | the workspace file |
| Deleted (either group) | the older side | empty |

The index side needs a new revision kind: `RevisionRef.ref` gains the value `":"` (index), served
by `git show :<path>`; titles say "(Index)" or "(Working Tree)". The Log's Uncommitted side
(section 3.2) opens the same diffs as the Changes group, or Staged when a file is only staged.

### 4.5 Freshness

The existing machinery moves here, unchanged in behaviour: after the background read, saves and
VS Code Git's reports re-read only the repository that changed; repositories it does not report
on are read on every full read; Refresh reads every ticked repository.

## 5. Reading uncommitted work

### 5.1 Status

`git status --porcelain=v2 -z --branch --untracked-files=all [-- <pathspec>]` per ticked
repository (as today). `parseStatus` keeps the index (X) and worktree (Y) halves apart: an entry
becomes up to two files, a Staged one (X ≠ ".") and a Changes one (Y ≠ "." or untracked).

### 5.2 Counts

Only for repositories with entries: `git diff --cached --numstat -z -M <HEAD|empty tree>` (Staged)
and `git diff --numstat -z` (Changes, index ↔ worktree). Untracked files have no count from git:
they show "new" and count as 0/0 (not binary), as today.

### 5.3 Concurrency and order

As today: per-repository sequence numbers, a full read aborts partial reads, a save during a read
is read after it.

### 5.4 "edited N ago"

`fs.stat` mtime of up to 50 changed files per repository (deleted files skipped), the newest
wins; read with the status, async. Repositories with more than 50 changed files use the first 50.

## 6. Structure

| Module | Role | Pure |
|---|---|---|
| `src/uncommittedModel.ts` | Status → Staged/Changes files, folder tree, counts, meter, tags, totals, row labels, which diff, discard/commit prompt texts | yes |
| `src/uncommittedStore.ts` | Reads and events (moved from `logView.ts`): per-repo reads, seq, skip of identical full reads, the background read; emits `onDidChange` | no (git, fs) |
| `src/uncommittedView.ts` | The native TreeView + `TreeDataProvider`, inline actions, commands | no |
| `src/logView.ts` | Loses the uncommitted code; gains the switch state and the Uncommitted side, fed by the store | no |
| `src/changesModel.ts` / `changesTree.ts` | Loses Review groups; gains All Files (section 7) and the review-only repo tree for the switch | partly |
| `src/webview/*` | The switch, the Uncommitted list rows, totals; `emptyState` texts | yes (view.ts) |

The store gets the Repo List ticks and the Path box from the Log through one event
(`onDidChangeScope`). Git actions use vscode.git's API object already held by `RepoDiscovery`
(new methods `stage`, `unstage`, `discard`, `commit`, each refusing a repository it has not
opened).

## 7. Changes view: All Files

- A toggle in the Changes view title (`polylog.changesShowAll` / `polylog.changesShowChanged`,
  icons `list-tree` / `diff`), remembered in `globalState`, context key
  `polylog.changesAllFiles`. It applies to every commit, File History included; not to the
  Log's Uncommitted side.
- All Files shows the repository at that commit: folders first, then files, A to Z.
- Folders holding changes start expanded; others collapsed. A folder's description counts its
  changed files, shown only when non-zero.
- Changed files look as today; deleted files are listed where they were, with D.
- Clicking a changed file opens its diff; an unchanged one opens read-only at that commit
  (`polylog:` URI), titled "Summary.tsx (a1b2c3d)". Right-click: Open File, File History.
- **Lazy:** `git ls-tree -z <sha> -- <dir>/` when a folder is first expanded (TreeView
  `getChildren`); switching on reads the root plus the folders holding changes. Selecting
  another commit aborts reads still running. `parseLsTree` is pure and unit-tested.

## 8. Commands, menus, settings, context keys

Added: `polylog.focusUncommitted` (palette), `polylog.refreshUncommitted` (view toolbar, palette),
`polylog.uncommittedCollapseAll`, `polylog.stage`, `polylog.unstage`, `polylog.discard`,
`polylog.commitRepo` (inline/context only, hidden from the palette), `polylog.changesShowAll`,
`polylog.changesShowChanged`.

Removed: `polylog.showUncommitted`, `polylog.hideUncommitted`, `polylog.reviewUncommitted`
(commands); `polylog.showUncommitted`, `polylog.keepViewsExpanded` (settings).

View: `polylog.uncommitted` in the `polylog` panel container, `"visibility": "collapsed"`.

## 9. Testing

**Unit (pure):** `uncommittedModel` (both groups for a partly staged file; untracked in Changes;
folders and counts; meter split; tags; totals; row label truncation; which diff per row;
discard text with new files; smart-commit decision), `parseStatus` X/Y split, numstat merge,
`parseLsTree`, All Files merge (deleted placed back, open folders, sort), the switch's labels,
the index revision URI round trip.

**Integration (stable and 1.85):**
- the view lists only ticked repositories with work; unticking removes one;
- a save re-reads only its repository;
- Stage, Unstage, Discard change git (checked with `git status` from outside) and the view;
  Discard declined changes nothing;
- Commit with a message: in `git log`, at the top of the Log, the repository leaves the view;
  nothing staged follows `git.enableSmartCommit`;
- the switch: badge count after the first page, the Uncommitted side's rows, a click fills the
  Changes view, Commits restores filters;
- All Files: unchanged files listed, a deleted file listed, an unchanged file opens as it was,
  expanding a folder reads only that folder;
- removals: no eye, no Review Uncommitted mode, no pinned rows; the old setting set to true breaks
  nothing; no view is re-expanded by Polylog after a collapse;
- each new test fails under mutation of the feature it covers.

**Real VS Code (Xvfb capture):** the view collapsed on a first install, the switch, hover
buttons, the Discard dialog, in dark, light and high contrast.

**Perf harness (68 repositories):** budgets: first rows unchanged (about 0.4 s); the badge's
background read after first rows ≤ 0.3 s, adds 68 `status` spawns at startup (plus numstat for
dirty ones); a save 2–4 spawns; Stage/Unstage one repository read; All Files first level ≤ 0.1 s.

## 10. Docs

README (the Uncommitted view, the switch, All Files; removed parts), CHANGELOG at release,
the UI Map (add the switch, Uncommitted list row, Uncommitted view parts, All Files toggle;
remove Uncommitted row 16 and the two toolbar buttons), CLAUDE.md's opening paragraph (Polylog is
a merged history plus a cross-repository view of uncommitted work and branches; still no index,
filters still in git).

## 11. Risks

- vscode.git's API (`add`, `revert`, `clean`, `commit`) differs across VS Code versions; the
  1.85 floor must have all four (checked before planning; otherwise run the same git commands
  for repositories it has open, and refresh it with `status()`).
- Startup cost rises by one status read per ticked repository (the badge); measured in the perf
  harness, never on the first page's path.
- A partly staged file shown twice can surprise; it matches Source Control, and its two rows open
  different diffs.
