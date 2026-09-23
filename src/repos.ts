import type { Repo } from "./types";

const segments = (p: string) => p.split(/[\\/]+/).filter(Boolean);
const baseName = (p: string) => segments(p).at(-1) ?? p;

function countBy<T>(items: readonly T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return m;
}

/** Folder-name labels, disambiguated by parent folder, then by full path. */
export function labelRepos(roots: readonly string[]): Repo[] {
  const unique = [...new Set(roots)];
  const bases = countBy(unique, baseName);
  const named = unique.map((root) => {
    const name = baseName(root);
    return { id: root, root, name: bases.get(name)! > 1 ? `${name} (${segments(root).at(-2) ?? root})` : name };
  });
  const names = countBy(named, (r) => r.name);
  return named
    .map((r) => (names.get(r.name)! > 1 ? { ...r, name: r.root } : r))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else {
        re += ".*";
      }
    } else if (ch === "*") {
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function excludeRepos(repos: readonly Repo[], patterns: readonly string[]): Repo[] {
  const res = patterns.map(globToRegExp);
  return repos.filter((r) => {
    const root = r.root.replace(/\\/g, "/");
    return !res.some((re) => re.test(baseName(r.root)) || re.test(root));
  });
}
