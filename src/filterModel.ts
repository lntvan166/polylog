import { HISTORY_FORMAT, LOG_FORMAT } from "./gitLog";
import type { Repo } from "./types";

export type DatePreset = "24h" | "7d" | "30d" | "all" | "custom";

export interface FilterState {
  text: string;
  /** Matched against "Name <email>" by git's --author; "" = anyone. */
  author: string;
  /** "Me": each repository's own user.email, one more author beside the others. */
  mine: boolean;
  /**
   * Authors picked as chips (0.2.0). A commit by any of them, by the typed `author`, or by
   * Me matches: git combines several --author flags as "any of". Absent = none.
   */
  authors?: string[];
  /** A branch to show in every repository that has it ("" = each repo's current branch). */
  branch: string;
  /** null = every repository; [] = none. */
  repoIds: string[] | null;
  date: DatePreset;
  /** YYYY-MM-DD, local days, only meaningful when date === "custom". */
  from?: string;
  to?: string;
}

/**
 * Where the next page for one repository starts: a position in git's own walk
 * order. Never a date — git emits a child before its parents, so a commit with
 * a backwards clock would make a date cursor skip real history.
 */
export interface RepoCursor {
  skip: number;
}

export const DEFAULT_FILTER: FilterState = { text: "", author: "", mine: false, branch: "", repoIds: null, date: "24h" };

const PRESETS: readonly DatePreset[] = ["24h", "7d", "30d", "all", "custom"];
const PRESET_SECONDS = { "24h": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400 } as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** ISO-8601 UTC. git reads this exactly; it does NOT read `@<unix>` in --since/--until. */
export function gitDate(unix: number): string {
  return new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function localDay(day: string | undefined, time: "00:00:00" | "23:59:59"): number | undefined {
  if (!day || !DAY.test(day)) return undefined;
  const ms = new Date(`${day}T${time}`).getTime();
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

export function sinceOf(f: FilterState, now: number): number | undefined {
  if (f.date === "all") return undefined;
  if (f.date === "custom") return localDay(f.from, "00:00:00");
  return now - PRESET_SECONDS[f.date];
}

export function untilOf(f: FilterState): number | undefined {
  return f.date === "custom" ? localDay(f.to, "23:59:59") : undefined;
}

/**
 * git's ref-name rules (git check-ref-format), so any real branch is accepted —
 * "feature@x", "fix/#12", "fix/ü" — while options and revision syntax are not.
 * The ref is also passed after --end-of-options and before --.
 */
export function isValidRef(ref: string): boolean {
  if (!ref || ref === "@" || ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/") || ref.endsWith(".")) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref) || ref.includes("..") || ref.includes("@{") || ref.includes("//")) return false;
  return ref.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

interface ArgOptions {
  pageSize: number;
  now: number;
  cursor?: RepoCursor;
  /** This repository's user.email, for "Me". */
  me?: string;
  /** The revision to walk; absent = the current branch. */
  ref?: string;
}

function buildArgs(format: string, f: FilterState, o: ArgOptions, extra: readonly string[], paths: readonly string[] = []): string[] {
  const args = ["log", format, `--max-count=${o.pageSize}`];
  const text = f.text.trim();
  const authors = authorPatterns(f, o.me);
  // All patterns literal and case-insensitive; git ANDs --author with --grep, and ORs
  // several --author flags.
  if (text || authors.length > 0) args.push("--regexp-ignore-case", "--fixed-strings");
  if (text) args.push(`--grep=${text}`);
  for (const a of authors) args.push(`--author=${a}`);
  const since = sinceOf(f, o.now);
  if (since !== undefined) args.push(`--since=${gitDate(since)}`);
  const until = untilOf(f);
  if (until !== undefined) args.push(`--until=${gitDate(until)}`);
  if (o.cursor && o.cursor.skip > 0) args.push(`--skip=${o.cursor.skip}`);
  args.push(...extra);
  // After --end-of-options: revisions, never options. After --: paths, never
  // revisions, so a branch named like a folder ("docs") is not ambiguous.
  if (o.ref) args.push("--end-of-options", o.ref);
  args.push("--", ...paths);
  return args;
}

export function logArgs(f: FilterState, o: ArgOptions): string[] {
  return buildArgs(LOG_FORMAT, f, o, []);
}

/**
 * One file's history with the Log's filters: every name the file has had is a
 * pathspec (see historyPathsArgs). No --follow: it cannot page with --skip, and
 * it stops following when the rename commit itself is filtered out.
 */
export function historyArgs(f: FilterState, o: ArgOptions & { paths: readonly string[] }): string[] {
  return buildArgs(HISTORY_FORMAT, f, o, ["--name-status", "-z", "-M"], o.paths);
}

/** Unfiltered, unpaged --follow walk that only collects the names a file has had. */
export function historyPathsArgs(path: string, ref?: string): string[] {
  return ["log", "--follow", "--name-status", "-z", "-M", "--format=%x1e", ...(ref ? ["--end-of-options", ref] : []), "--", path];
}

/** The file's names, newest first; always starts with its current path. */
export function parseHistoryPaths(stdout: string, path: string): string[] {
  const names = [path];
  const add = (p: string | undefined) => {
    if (p && !names.includes(p)) names.push(p);
  };
  const t = stdout.split(/[\x00\x1e]/);
  for (let i = 0; i < t.length; i++) {
    const m = /^\n*([AMDRCT])\d*$/.exec(t[i]);
    if (!m) continue;
    if (m[1] === "R" || m[1] === "C") {
      add(t[i + 1]);
      add(t[i + 2]);
      i += 2;
    } else {
      add(t[i + 1]);
      i += 1;
    }
  }
  return names;
}

const MAX_AUTHORS = 20;

/**
 * Every author pattern for one repository: the chips, what is being typed, and Me (that
 * repository's user.email, if it has one). Trimmed, blank-free, de-duplicated ignoring case.
 */
export function authorPatterns(f: FilterState, me?: string): string[] {
  const all = [...(f.authors ?? []), f.author, f.mine ? me ?? "" : ""].map((a) => a.trim()).filter((a) => a !== "");
  const seen = new Set<string>();
  return all.filter((a) => {
    const k = a.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Authors besides Me: with none, a repository without user.email has nothing to show. */
export function hasOtherAuthors(f: FilterState): boolean {
  return authorPatterns({ ...f, mine: false }).length > 0;
}

export function selectRepos(f: FilterState, repos: readonly Repo[]): Repo[] {
  if (f.repoIds === null) return [...repos];
  const ids = new Set(f.repoIds);
  return repos.filter((r) => ids.has(r.id));
}

function authorsOf(raw: unknown): { authors?: string[] } {
  if (!Array.isArray(raw)) return {};
  const authors = raw.filter((a): a is string => typeof a === "string" && a.trim() !== "").slice(0, MAX_AUTHORS);
  return authors.length > 0 ? { authors } : {};
}

export function sanitizeFilter(raw: unknown): FilterState {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const date = PRESETS.find((p) => p === r.date) ?? DEFAULT_FILTER.date;
  const f: FilterState = {
    text: typeof r.text === "string" ? r.text : "",
    author: typeof r.author === "string" ? r.author : "",
    mine: r.mine === true,
    ...authorsOf(r.authors),
    branch: typeof r.branch === "string" && isValidRef(r.branch) ? r.branch : "",
    repoIds: Array.isArray(r.repoIds) ? r.repoIds.filter((x): x is string => typeof x === "string") : null,
    date,
  };
  if (date === "custom") {
    if (typeof r.from === "string" && DAY.test(r.from)) f.from = r.from;
    if (typeof r.to === "string" && DAY.test(r.to)) f.to = r.to;
  }
  return f;
}

/** True when only typed fields (search text, author) changed: those are debounced. */
export function sameExceptText(a: FilterState, b: FilterState): boolean {
  const ids = (x: FilterState) => (x.repoIds === null ? null : x.repoIds.join("\0"));
  const authors = (x: FilterState) => (x.authors ?? []).join("\0");
  return a.mine === b.mine && authors(a) === authors(b) && a.branch === b.branch && a.date === b.date && a.from === b.from && a.to === b.to && ids(a) === ids(b);
}
