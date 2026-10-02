# Layout D: a Polylog Compare tab, sides left | right — Design

Part of project 3 (the UI pass). Status: approved in brainstorming on 2026-10-02. Visual
reference: brainstorm companion `layouts.html`, option D (with its Files | Commits toggle).
Part names follow the UI Map (`dev/ui-map/index.html`, `/ui-map`).

## 1. Goal

Four views in one panel row crush the Log, and using the Log and Compare together means
collapsing views. Layout D gives each part room:

| Where | What |
|---|---|
| Panel tab **Polylog** | **Log** + **Changes** (as before, full width) |
| Panel tab **Polylog Compare** | **Repositories** · **◀ `<left>` only** · **▶ `<right>` only**: three native views side by side |
| Side bar **Polylog** (its own Activity Bar icon) | **Uncommitted** (native tree, like Source Control) |

Every tree is native, so the user's file icon theme applies everywhere except the Log's own
commit rows. A file opens its diff in the editor area. Between Log and Compare: one click on
a panel tab.

Not in this change: the Log webview's own look (the rest of project 3), new settings.

## 2. Containers and views

| # | Rule |
|---|------|
| 1 | `viewsContainers.panel`: `polylog` (title "Polylog", existing) and `polylog-compare` (title "Polylog Compare", icon `media/compare.svg`, a monochrome git-compare glyph in `currentColor`). |
| 2 | `viewsContainers.activitybar`: `polylog-side` (title "Polylog", icon `media/polylog.svg`). |
| 3 | `polylog`: `polylog.log` (webview, icon `$(history)`), `polylog.changes` (icon `$(diff)`). |
| 4 | `polylog-compare`: `polylog.compare` named **Repositories** (icon `$(repo)`), `polylog.compareLeft` (icon `$(arrow-left)`), `polylog.compareRight` (icon `$(arrow-right)`). |
| 5 | `polylog-side`: `polylog.uncommitted` (icon `$(diff-modified)`), no longer `visibility: collapsed` (the side bar is closed until opened, which is enough). |
| 6 | Views the user moved before stay where the user put them (VS Code keeps a user's own layout). |
| 7 | Polylog never opens, focuses or reveals a view by itself; commands the user runs do (rule 8 of the Uncommitted spec stands). |
| 8 | `.vscodeignore` allowlist gains `media/compare.svg`. |

## 3. The Polylog Compare tab

### 3.1 Repositories (`polylog.compare`)

- Title actions: **Pick Branches…** (`$(git-branch)`), **Swap Sides** (`$(arrow-swap)`),
  **Show Commits** / **Show Files** (`$(git-commit)` / `$(files)`, context key
  `polylog.compareMode`), **Refresh** (`$(refresh)`). Files is the default.
- Description: the pair, `release-1.4 ↔ main` (no `origin/`).
- Message (above the rows): the summary, `22 repositories differ · =10 on both · 39 identical
  · 7 missing a branch · in 68 repositories` (`=0`/`0 identical` left out); while reading,
  `Reading 68 repositories… <summary so far>`; the same-branch and no-ticks messages as before.
- Welcome (no pair): "Compare two branches in every ticked repository…" and a **Pick
  Branches…** button (`viewsWelcome`).
- Rows: one per ticked repository whose files differ, Repo List order.
  - Label: the repository name; icon `$(repo)`.
  - Description: `3 ◀ · 1 ▶ · =1`. These are commit counts with merges left out; a zero part
    is dropped (`5 ◀`, `2 ▶`), and so is `=0`.
  - Tooltip: `3 commits only on release-1.4, 1 only on main, 1 on both (merges not counted)`.
  - Rows that cannot be compared say why instead: "no common history", "git error" (with
    the `$(warning)` icon; tooltip: git's message).
  - Expandable only when `=N` > 0. The children are the duplicates: subject, with
    `◀ 3f9a2c1 · ▶ b71e0d4`.
  - Right-click: the repository menu (Pull when behind, Show Only in Log, Hide from Log, Open
    Folder, Copy Path).
- A last row, **Missing a branch** (`$(circle-slash)`, description "7 repositories"),
  expands to their names.
- **Selecting a repository fills both side views.** The first listed repository is selected
  when the list fills; the selection stays on its repository across a refresh while listed.

### 3.2 Side views (`polylog.compareLeft`, `polylog.compareRight`)

- Title (set at runtime): `release-1.4 only` / `main only`; before a pair, "Left" / "Right".
- Description: the selected repository and count, `acme-api · 3 files` (Files) or
  `acme-api · 2 commits` (Commits).
- **Files** mode: the files that side changed since the branches split (merge base → that
  side's tip), as a folder tree: folders expanded, file icons from the theme (`resourceUri`
  on a private scheme), status letter and color as in Source Control. Description `+a −d`,
  plus `· both` when the other side changed the same path. Renames: `← old` in the tooltip.
  A click opens the diff: merge base ↔ that side's tip.
- **Commits** mode: that side's commits not on the other (merges and duplicates left out),
  newest first. Each row: the subject, with `author · 2d ago` as its description. A commit
  expands to its files (same file rows); a click opens that commit's diff (parent ↔ commit).
  Up to 500 commits, then a "Show 500 more" row.
- Message: "Select a repository in Repositories." with no selection; "No changes on this
  side." when empty; the "no common history" / git error text for such a repository.

### 3.3 Reading

Unchanged from the Compare spec and its later fixes: the CompareStore reads (tree-identical
means identical, `--no-merges`, 4 repositories at a time, waits for the Log's first page).

- **Repositories hidden** (the tab is closed, or the view is collapsed): the reads stop. When
  it is shown again, the remembered pair is read again.
- Side views read only the selected repository's detail.
- That detail is read again when its result changes (Fetch All, a pull, a branch moved).

## 4. Commands

- `polylog.compareBranches` (Log toolbar ⇄, Command Palette) focuses Repositories, which
  opens the Polylog Compare tab. With no pair ever picked, it runs Pick Branches….
- `polylog.compareWith` (Commit list right-click) stays as it is.
- `polylog.focusUncommitted` reveals the Polylog side bar's Uncommitted view.
- The Log's **Commits | Uncommitted** switch stays: the Uncommitted side of the Log still
  lists repositories with work and fills Changes.

## 5. Structure

| Unit | Change |
|---|---|
| `src/compareView.ts` | Split into `CompareRepos` (Repositories tree, title actions, Quick Pick, selection) and `CompareSide` (one class, two instances: left, right). They share one small `CompareSelection` (selected repo, mode, detail key) emitter. |
| `src/compareModel.ts` | `repoCounts(c)` → `3 ◀ · 1 ▶ · =1` (pure, unit-tested); `repoDescription` keeps the "why not" texts. |
| `package.json` | Containers, views, icons, title menus per view, `viewsWelcome`. |
| `media/compare.svg` | New. |

## 6. Testing

- **Unit:** `repoCounts`, covering zero parts dropped, `=0` dropped, and "no common history".
- **Integration (stable and 1.85):**
  - the contribution has the three containers, the view ids, their icons, and the views'
    containers;
  - picking a pair lists repositories with counts;
  - selecting a repository fills both side views in Files mode, with "both" marked;
  - Commits mode lists the side commits, and a commit expands to its files;
  - swap mirrors the counts and side titles;
  - a file opens its diff with the right sides;
  - hiding Repositories stops reads, and showing it reads again;
  - Fetch All re-reads the selected repository's detail;
  - the existing Uncommitted tests pass with the view in the side bar.
- **Real VS Code:** the try-out script (demo workspace, Material icon theme), with
  screenshots of both panel tabs and the side bar, read before handing over.

## 7. Docs

- README: the layout (two panel tabs and the side bar) and the Compare tab.
- UI Map: the containers; Repositories, the side views, and the Polylog side bar. The
  Compare entries are renumbered as needed.
- CHANGELOG is written at release.

## 8. Risks

- **Existing users** keep any view positions they set themselves. Untouched views move to
  their new defaults on update, which may surprise someone. The README and CHANGELOG say so.
- **Two side views follow one selection.** If the user collapses one, it reads nothing until
  it is shown.
- **Panel width:** three views share the tab's width. Each is a tree, so narrow is fine, and
  the user can resize them.
