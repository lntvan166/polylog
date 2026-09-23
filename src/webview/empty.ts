import { clear, h } from "./dom";
import type { EmptyAction, EmptyState } from "./view";

export class EmptyView {
  private last = "";

  constructor(private readonly root: HTMLElement, private readonly onAction: (action: EmptyAction) => void) {}

  render(state: EmptyState | null): void {
    const key = JSON.stringify(state);
    if (key === this.last) return;
    this.last = key;
    clear(this.root);
    this.root.hidden = state === null;
    if (!state) return;
    this.root.append(h("h2", {}, [state.title]), h("p", {}, [state.body]));
    if (state.action) {
      const { id, label } = state.action;
      const button = h("button", { type: "button" }, [label]);
      button.addEventListener("click", () => this.onAction(id));
      this.root.append(button);
    }
  }
}
