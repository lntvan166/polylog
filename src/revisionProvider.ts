import * as vscode from "vscode";
import type { RunGit } from "./logQuery";
import { decodeRevision } from "./revisionUri";

/** Serves `polylog:` URIs: the content of <ref>:<path> in one repository. */
export class RevisionProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly run: RunGit) {}

  async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
    const rev = decodeRevision(uri.path, uri.query);
    if (rev.ref === null) return ""; // a root commit's "before" side
    const ctl = new AbortController();
    const sub = token.onCancellationRequested(() => ctl.abort());
    const spec = `${rev.ref}:${rev.path}`;
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
