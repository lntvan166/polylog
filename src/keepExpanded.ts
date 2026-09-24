// The Log and Changes views share one panel tab, so VS Code gives each a header that
// collapses it on click — and a collapsed view stays collapsed across restarts. There is
// no API to make a header inert, so a collapse is undone instead. Pure: no vscode import.

/**
 * Which view to expand again, given each view's visibility once events have settled.
 * `log` is undefined when the Log never loaded (it was collapsed before the window
 * opened). Both hidden means the panel is closed or on another tab: nothing to undo.
 */
export function collapsedPeer(log: boolean | undefined, changes: boolean): "log" | "changes" | null {
  if (changes && !log) return "log";
  if (log && !changes) return "changes";
  return null;
}

type View = "log" | "changes";

/**
 * collapsedPeer, with a way out. The rule "one view shows, the other does not" cannot tell a
 * header click from "Hide 'Changes'", or from Changes dragged to another container while the
 * panel closes. So each view is expanded again at most once per `window`: hidden again within
 * it, the user means it, and that view is left alone until the window reloads.
 */
export class UndoCollapse {
  private readonly lastUndo = new Map<View, number>();
  private readonly gaveUp = new Set<View>();

  constructor(private readonly window: number) {}

  /** `can`: which views can be expanded right now without taking focus. */
  decide(log: boolean | undefined, changes: boolean, now: number, enabled: boolean, can: Record<View, boolean> = { log: true, changes: true }): View | null {
    const which = enabled ? collapsedPeer(log, changes) : null;
    if (!which || this.gaveUp.has(which) || !can[which]) return null;
    const last = this.lastUndo.get(which);
    if (last !== undefined && now - last < this.window) {
      this.gaveUp.add(which);
      return null;
    }
    this.lastUndo.set(which, now);
    return which;
  }
}
