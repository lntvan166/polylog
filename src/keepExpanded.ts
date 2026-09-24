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
