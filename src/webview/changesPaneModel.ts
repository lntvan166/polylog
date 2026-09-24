// The Changes pane's tree, drawn in the Log webview (panel spec §15). The host describes
// the commit (changesModel.describeChanges); this turns that into rows and key moves.
// Pure: no DOM.
import type { NodeDesc } from "../changesModel";

export interface TreeRow {
  node: NodeDesc;
  depth: number;
  /** true/false for the commit and folders (open or folded); undefined for files. */
  expanded: boolean | undefined;
  /** Index of the row's parent, or -1 at the top. */
  parent: number;
}

/** Visible rows, depth-first. `folded` holds node ids, so folds survive a re-render. */
export function flatten(roots: readonly NodeDesc[], folded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (nodes: readonly NodeDesc[], depth: number, parent: number): void => {
    for (const node of nodes) {
      const expandable = node.kind !== "file";
      const expanded = expandable ? !folded.has(node.id) : undefined;
      rows.push({ node, depth, expanded, parent });
      if (node.kind !== "file" && expanded) walk(node.children, depth + 1, rows.length - 1);
    }
  };
  walk(roots, 0, -1);
  return rows;
}

export type TreeMove = { active: number } | { fold: string } | { unfold: string } | { open: string };

/** What a key does in the tree, like VS Code's own trees. null: not a tree key. */
export function treeKey(key: string, rows: readonly TreeRow[], active: number): TreeMove | null {
  if (rows.length === 0) return null;
  const at = Math.min(Math.max(active, 0), rows.length - 1);
  const row = rows[at];
  switch (key) {
    case "ArrowDown": return { active: Math.min(at + 1, rows.length - 1) };
    case "ArrowUp": return { active: Math.max(at - 1, 0) };
    case "Home": return { active: 0 };
    case "End": return { active: rows.length - 1 };
    case "ArrowLeft":
      if (row.expanded === true) return { fold: row.node.id };
      return row.parent >= 0 ? { active: row.parent } : null;
    case "ArrowRight":
      if (row.expanded === false) return { unfold: row.node.id };
      if (row.expanded === true && rows[at + 1]?.parent === at) return { active: at + 1 };
      return null;
    case "Enter":
    case " ":
      if (row.node.kind === "file") return { open: row.node.path };
      return row.expanded ? { fold: row.node.id } : { unfold: row.node.id };
    default:
      return null;
  }
}

/**
 * The row's `data-vscode-context`: VS Code picks the native right-click menu by
 * webviewSection (package.json "webview/context"), and passes this object to the command.
 */
export function contextFor(node: NodeDesc): string {
  const base = { webviewSection: node.kind, preventDefaultContextMenuItems: true };
  return JSON.stringify(node.kind === "file" ? { ...base, path: node.path } : base);
}
