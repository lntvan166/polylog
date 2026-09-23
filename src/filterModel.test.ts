import * as assert from "assert";
import { LOG_FORMAT } from "./gitLog";
import { DEFAULT_FILTER, gitDate, logArgs, sameExceptText, sanitizeFilter, selectRepos, type FilterState } from "./filterModel";
import type { Repo } from "./types";

const NOW = 1790164800; // 2026-09-23T12:00:00Z
const ALL: FilterState = { ...DEFAULT_FILTER, date: "all" };
const args = (f: FilterState, cursor?: { skip: number }) => logArgs(f, { pageSize: 200, now: NOW, cursor });
const localStart = (day: string) => Math.floor(new Date(`${day}T00:00:00`).getTime() / 1000);
const localEnd = (day: string) => Math.floor(new Date(`${day}T23:59:59`).getTime() / 1000);

// ── gitDate is the ISO form git reads exactly (it ignores `@<unix>`) ────────
{
  assert.strictEqual(gitDate(2000), "1970-01-01T00:33:20Z");
  assert.strictEqual(gitDate(NOW), "2026-09-23T12:00:00Z");
  console.log("ok - gitDate formats ISO-8601 UTC without milliseconds");
}

// ── No filters: the bare log, and no --grep at all ──────────────────────────
{
  assert.deepStrictEqual(args(ALL), ["log", LOG_FORMAT, "--max-count=200"]);
  assert.deepStrictEqual(args({ ...ALL, text: "   " }), ["log", LOG_FORMAT, "--max-count=200"]);
  console.log("ok - empty or whitespace search omits --grep entirely");
}

// ── Search is literal and case-insensitive ──────────────────────────────────
{
  assert.deepStrictEqual(args({ ...ALL, text: " ACME-7 " }), ["log", LOG_FORMAT, "--max-count=200", "--regexp-ignore-case", "--fixed-strings", "--grep=ACME-7"]);
  for (const text of ["fix(api)", "[ACME-7]", ".", "a|b", "^x$"]) {
    const a = args({ ...ALL, text });
    assert.ok(a.includes("--fixed-strings") && a.includes(`--grep=${text}`), `literal: ${text}`);
  }
  console.log("ok - regex metacharacters are searched literally (--fixed-strings)");
}

// ── A search can never become a git option ──────────────────────────────────
{
  const a = args({ ...ALL, text: "--output=/tmp/pwned" });
  assert.ok(a.includes("--grep=--output=/tmp/pwned"));
  assert.ok(!a.includes("--output=/tmp/pwned"), "never a standalone argument");
  console.log("ok - search text stays inside --grep= (argv array, no shell)");
}

// ── Date presets ────────────────────────────────────────────────────────────
{
  assert.ok(args({ ...ALL, date: "24h" }).includes(`--since=${gitDate(NOW - 86_400)}`));
  assert.ok(args({ ...ALL, date: "7d" }).includes(`--since=${gitDate(NOW - 7 * 86_400)}`));
  assert.ok(args({ ...ALL, date: "30d" }).includes(`--since=${gitDate(NOW - 30 * 86_400)}`));
  assert.ok(!args(ALL).some((a) => a.startsWith("--since")));
  console.log("ok - presets map to --since relative to now; All adds none");
}

// ── Custom range is whole local days, inclusive; malformed bounds dropped ──
{
  const a = args({ ...ALL, date: "custom", from: "2026-09-01", to: "2026-09-10" });
  assert.ok(a.includes(`--since=${gitDate(localStart("2026-09-01"))}`));
  assert.ok(a.includes(`--until=${gitDate(localEnd("2026-09-10"))}`));
  const b = args({ ...ALL, date: "custom", from: "09/01/2026" });
  assert.ok(!b.some((x) => x.startsWith("--since") || x.startsWith("--until")));
  console.log("ok - custom from/to cover whole local days; malformed dates are ignored");
}

// ── Cursor: a walk position (--skip), never a date ──────────────────────────
{
  const a = args(ALL, { skip: 3 });
  assert.ok(a.includes("--skip=3"));
  assert.ok(!a.some((x) => x.startsWith("--until")), "paging never adds --until: git's walk order is not date order");
  assert.ok(!args(ALL, { skip: 0 }).some((x) => x.startsWith("--skip")));
  const c = args({ ...ALL, date: "custom", to: "2026-09-10" }, { skip: 5 });
  assert.ok(c.includes(`--until=${gitDate(localEnd("2026-09-10"))}`) && c.includes("--skip=5"), "a custom end date still applies");
  console.log("ok - a cursor adds only --skip; the custom end date is independent of paging");
}

// ── Repo subset ─────────────────────────────────────────────────────────────
{
  const repos: Repo[] = ["acme-web", "acme-api", "acme-libs"].map((n) => ({ id: `/ws/${n}`, root: `/ws/${n}`, name: n }));
  assert.deepStrictEqual(selectRepos(ALL, repos), repos);
  assert.deepStrictEqual(selectRepos({ ...ALL, repoIds: ["/ws/acme-api", "/ws/gone"] }, repos).map((r) => r.name), ["acme-api"]);
  assert.deepStrictEqual(selectRepos({ ...ALL, repoIds: [] }, repos), []);
  console.log("ok - null selects all, a subset selects those, stale ids are ignored");
}

// ── Persisted state is untrusted: sanitize it ───────────────────────────────
{
  assert.deepStrictEqual(sanitizeFilter(undefined), DEFAULT_FILTER);
  assert.deepStrictEqual(sanitizeFilter("garbage"), DEFAULT_FILTER);
  assert.deepStrictEqual(sanitizeFilter({ text: 7, repoIds: ["/a", 3], date: "forever" }), { text: "", author: "", repoIds: ["/a"], date: "30d" });
  assert.deepStrictEqual(sanitizeFilter({ text: "x", author: "rin", repoIds: null, date: "7d", from: "2026-09-01" }), { text: "x", author: "rin", repoIds: null, date: "7d" });
  assert.deepStrictEqual(sanitizeFilter({ text: "", author: 4, repoIds: null, date: "custom", from: "2026-09-01", to: "nope" }), { text: "", author: "", repoIds: null, date: "custom", from: "2026-09-01" });
  console.log("ok - sanitizeFilter repairs corrupt persisted state");
}

// ── sameExceptText drives the debounce decision ────────────────────────────
{
  assert.ok(sameExceptText({ ...ALL, text: "a" }, { ...ALL, text: "ab" }));
  assert.ok(sameExceptText({ ...ALL, author: "ri" }, { ...ALL, author: "rin" }), "typing an author is debounced like search");
  assert.ok(!sameExceptText(ALL, { ...ALL, date: "7d" }));
  assert.ok(!sameExceptText(ALL, { ...ALL, repoIds: [] }));
  assert.ok(!sameExceptText({ ...ALL, repoIds: ["/a"] }, { ...ALL, repoIds: ["/b"] }));
  assert.ok(!sameExceptText({ ...ALL, date: "custom", from: "2026-09-01" }, { ...ALL, date: "custom", from: "2026-09-02" }));
  console.log("ok - sameExceptText is true only when nothing but the search changed");
}

// ── Author is pushed down as --author, literal and case-insensitive ────────
{
  assert.deepStrictEqual(args({ ...ALL, author: " Rin " }), ["log", LOG_FORMAT, "--max-count=200", "--regexp-ignore-case", "--fixed-strings", "--author=Rin"]);
  const both = args({ ...ALL, text: "ACME-7", author: "dana@example.com" });
  assert.deepStrictEqual(both.filter((a) => a === "--fixed-strings").length, 1, "the literal/case flags are given once");
  assert.ok(both.includes("--grep=ACME-7") && both.includes("--author=dana@example.com"));
  assert.ok(!args({ ...ALL, author: "  " }).some((a) => a.startsWith("--author")), "blank author adds nothing");
  const inj = args({ ...ALL, author: "--output=/tmp/pwned" });
  assert.ok(inj.includes("--author=--output=/tmp/pwned") && !inj.includes("--output=/tmp/pwned"));
  console.log("ok - author becomes one literal, case-insensitive --author= argument");
}
