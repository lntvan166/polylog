// Which git binary to run, in order of preference. Pure: no vscode import.

/**
 * `setting` is VS Code's `git.path` (a path, an array of paths, or null); `apiPath` is the
 * binary VS Code's Git extension actually found. The user's setting comes first, as in
 * VS Code's own Git extension; plain `git` from PATH is always the last resort.
 */
export function gitCandidates(setting: unknown, apiPath: string | undefined): string[] {
  const fromSetting = typeof setting === "string" ? [setting] : Array.isArray(setting) ? setting : [];
  const all = [...fromSetting, apiPath, "git"].filter((p): p is string => typeof p === "string" && p.trim() !== "");
  return [...new Set(all)];
}
