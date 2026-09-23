import { LOG_FORMAT } from "./gitLog";
import type { Repo } from "./types";

export type DatePreset = "24h" | "7d" | "30d" | "all" | "custom";

export interface FilterState {
  text: string;
  /** Matched against "Name <email>" by git's --author; "" = anyone. */
  author: string;
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

export const DEFAULT_FILTER: FilterState = { text: "", author: "", repoIds: null, date: "30d" };

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

export function logArgs(f: FilterState, o: { pageSize: number; now: number; cursor?: RepoCursor }): string[] {
  const args = ["log", LOG_FORMAT, `--max-count=${o.pageSize}`];
  const text = f.text.trim();
  const author = f.author.trim();
  // Both patterns literal and case-insensitive; git ANDs --author with --grep.
  if (text || author) args.push("--regexp-ignore-case", "--fixed-strings");
  if (text) args.push(`--grep=${text}`);
  if (author) args.push(`--author=${author}`);
  const since = sinceOf(f, o.now);
  if (since !== undefined) args.push(`--since=${gitDate(since)}`);
  const until = untilOf(f);
  if (until !== undefined) args.push(`--until=${gitDate(until)}`);
  if (o.cursor && o.cursor.skip > 0) args.push(`--skip=${o.cursor.skip}`);
  return args;
}

export function selectRepos(f: FilterState, repos: readonly Repo[]): Repo[] {
  if (f.repoIds === null) return [...repos];
  const ids = new Set(f.repoIds);
  return repos.filter((r) => ids.has(r.id));
}

export function sanitizeFilter(raw: unknown): FilterState {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const date = PRESETS.find((p) => p === r.date) ?? DEFAULT_FILTER.date;
  const f: FilterState = {
    text: typeof r.text === "string" ? r.text : "",
    author: typeof r.author === "string" ? r.author : "",
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
  return a.date === b.date && a.from === b.from && a.to === b.to && ids(a) === ids(b);
}
