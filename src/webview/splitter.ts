export interface SplitterWidth {
  get(): number;
  /** Apply (and clamp) a new width while dragging. */
  set(width: number): void;
  /** Save the width once the gesture is over. */
  commit(): void;
}

/**
 * The divider's drag and keyboard behavior. Every way a drag can end —
 * pointerup, pointercancel (touch/pen, the OS taking the pointer) and lost
 * capture — ends it once, so a later buttonless move can never keep resizing.
 */
export function attachSplitter(el: HTMLElement, width: SplitterWidth): void {
  let drag: { startX: number; startWidth: number } | null = null;
  const end = () => {
    if (!drag) return;
    drag = null;
    el.classList.remove("dragging");
    width.commit();
  };
  el.addEventListener("pointerdown", (e) => {
    const p = e as PointerEvent;
    if (p.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(p.pointerId);
    drag = { startX: p.clientX, startWidth: width.get() };
    el.classList.add("dragging");
  });
  el.addEventListener("pointermove", (e) => {
    if (drag) width.set(drag.startWidth + (e as PointerEvent).clientX - drag.startX);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(type, end);
  el.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    const step = key === "ArrowLeft" ? -16 : key === "ArrowRight" ? 16 : 0;
    if (!step) return;
    e.preventDefault();
    width.set(width.get() + step);
    width.commit();
  });
}
