# Compare Branches — Design

Project 2 of 3 (after the Uncommitted view, before a UI pass with impeccable). Status: approved in
brainstorming on 2026-10-01; the interactive demo (brainstorm companion, `compare-demo.html`) is
the visual reference. Part names follow the UI Map (`dev/ui-map/index.html`, `/ui-map`).

## 1. Goal

Before a release branch is merged into production, a person sees, across every repository at
once, what each of two branches has that the other has not:

- **◀ Left only** — commits on the left branch the right branch lacks (what the merge brings in);
- **▶ Right only** — commits on the right branch the left lacks (on the target, missing from the
  release: a hotfix never brought back);
- **= On both** — the same change committed separately on each side (a cherry-pick), found by
  git's patch comparison.

Repositories where neither side has anything are hidden. Each repository shows its differences as
one folder tree of changed files per side (the default) or as commits, and a file opens its diff.

Not in this project: merging, rebasing or cherry-picking from the tab; a different branch per
repository; a three-way preview of merge conflicts; a visual redesign of existing parts
(project 3).

Design direction: the native stack (plain TypeScript and CSS, `--vscode-*` variables only, no
framework), borrowing JetBrains' branch-compare patterns — a searchable branch popup with Recent,
Favorites, Local and Remote, and a Files/Commits view of each side.

## 2. Opening it

| # | Rule |
|---|------|
| 1 | **⇄ Compare Branches…** in the Log toolbar (before `⋯`) and in the Command Palette ("Polylog: Compare Branches…") open the **Compare tab**. |
| 2 | Right-click a commit in the Commit list → **Compare with…** opens the tab with the Log's Branch box name as the left side when the box has one (commit rows carry no branch labels), else the tab's last pair; the Branch picker opens on the right box. |
| 3 | One Compare tab: running the command again reveals it rather than opening a second. It is an editor tab (`WebviewPanel`, `retainContextWhenHidden: false`), titled `⇄ release-1.4 ↔ main` (names without `origin/`). |
| 4 | The tab opens on the last pair used in this workspace; the first time, it opens with both branch boxes empty and the Branch picker open on the left box. |
| 5 | Closing the tab stops every read it started. Reopening reads again (nothing is kept). |

## 3. The Compare tab

### 3.1 Compare toolbar

Left-aligned, two groups separated by extra space, then the summary at the right end; it wraps on
a narrow editor (the summary goes to a second line).

1. **What to compare:** `◀ left ▾` (Branch box, `charts.blue` inset edge), **⇄** (swap),
   `▶ right ▾` (Branch box, `charts.yellow` inset edge).
2. **How to show it:** **Files | Commits** (segmented switch, `aria-pressed`; **Files is the
   default**; the choice is remembered in `workspaceState`), **↻** Refresh.
3. **Summary:** "5 repositories differ · ◀7 ▶3 =2 · 51 identical · 12 missing a branch · in 68
   repositories". "in N repositories" counts the ticked repositories (section 4.1), so a narrowed
   set is visible.

### 3.2 Branch picker

Opens under a Branch box on click, Enter or Space. A popup in the tab (not a native Quick Pick:
it needs groups, stars and a pair row).

| # | Rule |
|---|------|
| 1 | A search box, focused. Typing filters the names in the page (substring, case-insensitive); the matching part is highlighted with `list.highlightForeground`. Nothing is read from git while typing. |
| 2 | Groups in order: **Recent pairs** (up to 5, hidden while searching; one click sets both sides), **Favorites ★**, **Local**, **Remote**. A name may be in Favorites and in its own group. |
| 3 | Each name shows "in N repositories" (ticked repositories that have it). Sorted by N, then name. |
| 4 | ★ on a row toggles the favorite (workspaceState). |
| 5 | ↑/↓ move, Enter picks, Esc or a click outside closes and returns focus to the Branch box. |
| 6 | No match: "No branch named "x" in any repository." |
| 7 | The names come from one `git for-each-ref --format=%(refname) refs/heads refs/remotes` per repository (the read the Log's Branch box already does), when the picker first opens and after Refresh; `HEAD` refs are left out. |

### 3.3 Compare repo list

Down the left (240 px). Only the repositories that differ, in Repo List order, each with its
accent chip (as in the Log) and `◀n ▶n =n`. A listbox: ↑/↓ moves the selection, the selection
fills the columns. Right-click: the repository menu the Log has (Pull when behind, Show Only in
Log, Hide from Log, Open Folder, Copy Path).

Rows that cannot be compared say why instead of counts: **no common history** (the two branches
share no ancestor), **git error** (tooltip and the columns show git's own first error line).

**Missing footer** (folded `<details>` under the list): "origin/release-1.4 or origin/main is
missing in 12 repositories", unfolding to their names.

The first repository is selected when the list fills; the selection stays on its repository
across a Refresh while it is listed.

### 3.4 Compare columns

Two columns side by side: **◀ `<left>` only** and **▶ `<right>` only**, each with a sticky header
("3 files · since the split" / "2 commits · the merge brings these in" / "… · missing from
`<left>`").

**Files** (default): each column is a folder tree of the files that side changed since the
branches split (`git diff` from the merge base to that side's tip), folders first, with `+a −d`
(or "binary"). A file changed on both sides carries a **both** tag (tooltip: "Changed on both
sides since the split: look at it before merging"). Click or Enter on a file opens its diff:
merge base ↔ that side's tip, through the existing `polylog:` revision documents, titled
`limit.ts (merge base ↔ release-1.4)`. Renames show `← old`.

**Commits**: each column lists that side's commits not on the other (duplicates excluded), newest
first: subject, author, "2d ago", "2 files". Click or Enter expands the commit's files under it
(one expanded at a time per column); a file opens the commit's diff (parent ↔ commit), as the
Changes view does.

Empty column: "Nothing here: origin/main already has every commit of origin/release-1.4." (and
the mirror text).

More than 500 commits on a side: the first 500, then "Show 500 more" (Commits); Files is not
capped.

### 3.5 On both strip

Folded at the bottom of the columns: "= 1 on both — the same change committed on each side
(cherry-picked): the merge does not repeat it, but history lists it twice". Unfolded: each
duplicate as a row with `◀ 9968fa8` and `▶ b610e1e`; left and right duplicates are paired when
their subjects are equal, otherwise listed on their own with their side. In Files mode the strip
stays (its files appear in both trees and carry **both**).

### 3.6 Messages

| State | Shown |
|---|---|
| Both sides the same name | In place of the body: "Pick two different branches. Both sides are `<name>`." |
| A side empty (first use) | "Pick the branch to merge from (◀) and the branch it goes into (▶)." |
| Reading | The summary says "Reading 68 repositories…"; rows appear as each repository answers. |
| Nothing differs | "origin/release-1.4 and origin/main are the same in every repository." |
| No repository ticked | "No repositories are ticked in the Repo List." |

### 3.7 Look and keyboard

Only `--vscode-*` variables: ◀ `charts.blue`, ▶ `charts.yellow`, = and **both** `charts.green`,
`+`/`−` from `gitDecoration.added/deletedResourceForeground`, selection from `list.*`, outlines
from `contrastBorder` and `focusBorder` (high contrast draws them). Type from `--vscode-font-*`.
Every control is reachable with Tab; focus is always visible. Checked in the browser harness in
dark, light and high contrast, and by impeccable's detectors.

## 4. Reading the branches

No index, no cache: every number is a git read when asked for. All spawns async, through the
existing pool (`polylog.maxConcurrency`) and the Log's counted runner.

### 4.1 Scope

The repositories ticked in the Repo List (the same set the Log and the Uncommitted view read).
Ticking or unticking while the tab is open reads only what changed. Branch names apply to every
repository at once.

### 4.2 Per repository, for the list (every ticked repository, in parallel)

1. `git rev-parse --verify --quiet <L>^{commit} <R>^{commit}` → both ids, or the repository goes
   to the Missing footer. Equal ids → identical, counted, hidden.
2. `git merge-base <L> <R>` → exit 1: **no common history**.
3. `git rev-list --left-only --cherry-mark --count <L>...<R>` → `◀` and left duplicates (`=`).
4. `git rev-list --right-only --cherry-pick --count <L>...<R>` → `▶`.

An identical repository costs one spawn; a differing one four.

### 4.3 For the selected repository only

- **Files:** `git diff --numstat -z -M <R>...<L>` and `git diff --numstat -z -M <L>...<R>` (merge
  base to each tip); the **both** tags are the paths in both.
- **Commits:** `git log --left-only --cherry-mark --max-count=500 --format=… <L>...<R>` and the
  `--right-only` mirror. `+` rows go to the columns, `=` rows to the On both strip.
- **A commit's files:** the read the Changes view already uses.

### 4.4 Freshness

The tab reads again on ↻, after Fetch All, after a Pull from Polylog, and when VS Code's Git
reports a ref change (HEAD or a branch moved) in a ticked repository (that repository only,
debounced 400 ms). A new pair, a swap or a tick change aborts the reads in flight (constraint
4); a slower old read never replaces a newer one (sequence numbers, as in the Uncommitted
store). Swap does not re-read: it mirrors the result it has.

## 5. Structure

| Unit | Responsibility |
|---|---|
| `src/compareModel.ts` (pure) | `revParseArgs`, `mergeBaseArgs`, `countArgs`, `filesArgs`, `logArgs`; `parseCounts`, `parseSideLog`, `bothPaths`, `pairDuplicates`, `summary`, `tabTitle`, `recentPairs`, `pickerGroups`. No `vscode` import; unit-tested. |
| `src/compareStore.ts` (host) | The per-repository reads of section 4: scope, abort, sequence numbers, one `onDidChange` (coalesced 80 ms). |
| `src/comparePanel.ts` (host) | The editor-tab webview panel, its messages, workspaceState (pair, recent, favorites, mode), diff opening (reuses `revisionUri`), repository menu commands. |
| `src/webview/compare/` | The tab's page: toolbar, Branch picker, repo list, columns, strip. Plain TS, shares `dom.ts`, accents and chips from `view.ts`. Its own bundle `out/compare.js` and `out/compare.css`. |
| `src/protocol.ts` | Compare host ↔ webview messages (separate union from the Log's). |

The Log's `LogView` gives the store its ticked repositories and its counted runner, and forwards
Fetch All / Pull / ref changes; it gains no compare logic.

## 6. Commands, menus, settings

- Commands: `polylog.compareBranches` (palette, Log toolbar), `polylog.compareWith` (Commit list
  right-click; hidden from the palette).
- Settings: none new.
- workspaceState: `polylog.compare.pair`, `polylog.compare.recent`, `polylog.compare.favorites`,
  `polylog.compare.mode`.
- `.vscodeignore` allowlist gains `out/compare.js` and `out/compare.css`.

## 7. Testing

- **Unit** (`src/compareModel.test.ts`, appended to `test:unit`): every parser and arg builder;
  `bothPaths`; duplicate pairing (equal subjects, unequal, one-sided); summary text; recent pairs
  (dedupe, cap 5, order); picker groups and filtering.
- **Integration** (`src/integration/log.itest.ts`, stable and 1.85): fixture repositories with
  `origin/release-1.4` — acme-api with left-only, right-only and a cherry-picked duplicate;
  acme-web left only; acme-libs identical; one repository missing the branch. Checks: counts and
  hidden identical repository; Missing footer; Files trees with **both**; Commits columns and On
  both strip; swap; same-branch message; a file opens a diff with the right sides; one tab on a
  second run; untick a repository → it leaves; Fetch All → re-read; reads abort on a new pair.
- **Performance** (`perf.itest.ts`, 68 repositories): time to all counts after picking a pair
  (budget: one Log page, about 0.5 s) and spawns by command; `--cherry-mark` on a 2,000-commit
  divergence (if slow, `=` loads after ◀ ▶).
- **Theme:** the browser harness gets a Compare page with mock data; dark, light, high contrast;
  `check:theme`, `check:design`, impeccable detectors.
- **Denylist:** all fixtures use acme-*, dana / rin, origin/release-1.4.

## 8. Docs

README: a Compare Branches section (what ◀ ▶ = and **both** mean). UI Map: replace the planned
28 "Compare Branches view" with Compare tab, Compare toolbar, Branch picker, Compare repo list,
Compare columns, On both strip, Missing footer. CLAUDE.md's "later, of two branches" becomes
present tense. CHANGELOG is written at release.

## 9. Risks

- `--cherry-mark` computes a patch id for every commit in the symmetric difference: slow on a
  large divergence. Measured in section 7; the fallback is a second pass for `=`.
- Four spawns per differing repository: 56 differing repositories ≈ 225 spawns, like startup.
  Measured; budget as above.
- Duplicate pairing by subject is a heuristic for display only; counts come from git.
- A branch name that is a tag or a sha in some repositories: `rev-parse` accepts it, so it
  compares; the picker only offers branches.
