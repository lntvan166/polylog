import * as vscode from "vscode";
import type { RunGit } from "./logQuery";
import { decodeRevision, INDEX } from "./revisionUri";

/** Serves `polylog:` URIs: the content of <ref>:<path> in one repository. */
export class RevisionProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly run: RunGit, private readonly roots: () => readonly string[] = () => []) {}

  async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
    let rev: ReturnType<typeof decodeRevision>;
    try {
      rev = decodeRevision(uri.path, uri.query);
    } catch {
      return ""; // a malformed URI
    }
    if (rev.ref === null) return ""; // a root commit's "before" side
    // Only the workspace's repositories, and paths inside them (":/text" is git's commit search).
    if (!this.roots().includes(rev.root) || rev.path.startsWith("/") || rev.path.split("/").includes("..")) return "";
    const ctl = new AbortController();
    const sub = token.onCancellationRequested(() => ctl.abort());
    // The index is `:<path>` (or its blob, when known); a commit is `<sha>:<path>`.
    const spec = rev.ref === INDEX ? (rev.blob ?? `:${rev.path}`) : `${rev.ref}:${rev.path}`;
    try {
      return await this.run(rev.root, ["show", spec], ctl.signal);
    } catch (e) {
      // An added file has no "before", a deleted one no "after": show empty.
      // Anything else (a bad repository, a missing object) is a real error.
      const exists = await this.run(rev.root, ["cat-file", "-e", spec], ctl.signal).then(() => true, () => false);
      if (exists) throw e;
      return "";
    } finally {
      sub.dispose();
    }
  }
}
