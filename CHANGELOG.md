# Changelog

All notable changes to Polylog are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] — 2026-09-24

The first release.

### Added

- **One git log across every repository in the workspace.** Commits from all of them in
  one list, merged newest first by commit date, each with a chip showing the repository it
  belongs to. The chip column fits your longest repository name. A name too long for the
  space is shortened in the middle, so repositories that share a prefix stay apart, and the
  full name is always in the tooltip. Polylog opens as a tab in the bottom panel, next to Terminal.
- **Search and filters that apply to every repository at once:** commit message
  (literal, case-insensitive), author with a **Me** toggle inside the box, branch, and date range (last
  24 hours by default). Every filter becomes a `git log` flag, so git does the searching;
  there is no index and no cache to go stale.
- **Branch in every repo.** Type or pick a branch such as `origin/release-1.4`; each
  repository that has it shows it, the rest show their current branch, and the footer
  says how many of each.
- **Repositories pane** to choose which repositories the Log shows, with fuzzy search
  and multi-select. **Group by Repository** in the Log's title bar shows or hides it.
- **Native Changes tree** for the selected commit, with git status colors and badges.
  Clicking a file opens its diff in VS Code's diff editor above the panel. Right-click the
  commit to copy its SHA or message.
- **Open File** on a Polylog diff, or on a file in Changes, opens the file as it is in the
  workspace now, at the same line number (the file may have changed since).
- **File History.** Right-click a file in the Explorer, an editor, a tab or the Changes
  tree and choose **Polylog: File History**. The Log shows that file's commits, following
  renames. The diff follows the selection, so `↑`/`↓` steps through its revisions. It
  opens on all time, and closing it restores your date range.
- **The Log and Changes stay open.** A click on either header collapses it, and Polylog
  expands it again straight away. Hiding a view again right after (**Hide 'Changes'**, or
  moving a view out of the panel) is respected until the window reloads, and
  `polylog.keepViewsExpanded` turns this off.
- **Keyboard navigation:** `↑`/`↓`, `Home`/`End`, `PageUp`/`PageDown` to move, `Enter` to
  open the first changed file, `/` to search, `Esc` to clear.
- **Every color comes from your theme**, in light, dark and both high-contrast themes.

### Performance

- On a 68-repository, 16,000-commit workspace the first rows appear 0.4 s after the panel
  opens, and a message search across all history takes 0.6 s.
