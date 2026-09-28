/**
 * How far each repository's current branch is from its upstream, for the Repositories
 * pane's ↓/↑ badge. Local refs only (as of the last fetch): Polylog never fetches.
 * Pure: no vscode import.
 */
export interface AheadBehind {
  /** Commits on HEAD that the upstream does not have (not pushed). */
  ahead: number;
  /** Commits on the upstream that HEAD does not have (to pull). */
  behind: number;
}

/** Fails (no output to parse) on a detached HEAD or a branch without an upstream. */
export function aheadBehindArgs(): string[] {
  return ["rev-list", "--left-right", "--count", "HEAD...@{upstream}", "--"];
}

export function parseAheadBehind(out: string): AheadBehind | null {
  const m = /^(\d+)\t(\d+)\s*$/.exec(out);
  return m ? { ahead: Number(m[1]), behind: Number(m[2]) } : null;
}

const commits = (n: number) => `${n} ${n === 1 ? "commit" : "commits"}`;

/** The badge beside a repository's name, or null when it is up to date. */
export function syncLabel(s: AheadBehind): { text: string; title: string; behind: boolean } | null {
  const parts: string[] = [];
  const titles: string[] = [];
  if (s.behind > 0) {
    parts.push(`↓${s.behind}`);
    titles.push(`${commits(s.behind)} to pull from its upstream`);
  }
  if (s.ahead > 0) {
    parts.push(`↑${s.ahead}`);
    titles.push(`${commits(s.ahead)} not pushed`);
  }
  return parts.length === 0 ? null : { text: parts.join(" "), title: titles.join(", "), behind: s.behind > 0 };
}
