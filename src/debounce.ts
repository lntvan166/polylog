export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface Debounced {
  (): void;
  cancel(): void;
  flush(): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function debounce(fn: () => void, ms: number, timers: Timers = realTimers): Debounced {
  let handle: unknown;
  let pending = false;
  const run = () => {
    pending = false;
    handle = undefined;
    fn();
  };
  const d = (() => {
    if (pending) timers.clear(handle);
    pending = true;
    handle = timers.set(run, ms);
  }) as Debounced;
  d.cancel = () => {
    if (pending) timers.clear(handle);
    pending = false;
    handle = undefined;
  };
  d.flush = () => {
    if (!pending) return;
    timers.clear(handle);
    run();
  };
  return d;
}
