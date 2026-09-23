import { isSha, type Commit } from "./types";

// Fields separated by NUL, records terminated by RS (0x1e): no subject can be
// confused with a delimiter, so nothing needs escaping.
export const LOG_FORMAT = "--format=%H%x00%ct%x00%an%x00%ae%x00%s%x00%P%x1e";

export function parseLog(stdout: string, repoId: string): Commit[] {
  const records = stdout.split("\x1e");
  // Whatever follows the last RS is either git's trailing newline or a record
  // cut off by a killed process; neither is a commit.
  records.pop();
  const commits: Commit[] = [];
  for (const record of records) {
    const fields = record.replace(/^\n/, "").split("\0");
    if (fields.length !== 6) continue;
    const [sha, ct, author, email, subject, parents] = fields;
    const time = Number(ct);
    if (!isSha(sha) || !Number.isInteger(time)) continue;
    commits.push({ repoId, sha, time, author, email, subject, parents: parents ? parents.split(" ") : [] });
  }
  return commits;
}
