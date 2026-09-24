import { fitMiddle } from "./view";

// Real text width, in the element's own font: a canvas measures without touching layout.
const ctx = document.createElement("canvas").getContext("2d");
const cache = new Map<string, string>();

/** `name`, cut in the middle to fit `maxPx` in `el`'s font (el must be in the document). */
export function fitName(el: HTMLElement, name: string, maxPx: number): string {
  if (!ctx || maxPx <= 0) return name;
  const font = getComputedStyle(el).font;
  const key = `${font}|${Math.floor(maxPx)}|${name}`;
  let fitted = cache.get(key);
  if (fitted === undefined) {
    ctx.font = font;
    fitted = fitMiddle(name, (t) => ctx.measureText(t).width <= maxPx);
    if (cache.size > 2000) cache.clear();
    cache.set(key, fitted);
  }
  return fitted;
}

/** The space an element's text has: its box minus horizontal padding. */
export function textRoom(el: HTMLElement, box = el.getBoundingClientRect().width): number {
  const s = getComputedStyle(el);
  return box - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
}
