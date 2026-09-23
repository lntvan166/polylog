import * as assert from "assert";
import { debounce, type Timers } from "./debounce";

function fakeTimers(): Timers & { advance(ms: number): void } {
  let now = 0;
  let nextId = 0;
  const queue: { at: number; fn: () => void; id: number }[] = [];
  return {
    set: (fn, ms) => {
      queue.push({ at: now + ms, fn, id: ++nextId });
      return nextId;
    },
    clear: (handle) => {
      const i = queue.findIndex((t) => t.id === handle);
      if (i >= 0) queue.splice(i, 1);
    },
    advance(ms) {
      now += ms;
      for (const t of queue.filter((q) => q.at <= now)) {
        queue.splice(queue.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

{
  const t = fakeTimers();
  let calls = 0;
  const d = debounce(() => calls++, 250, t);
  for (let i = 0; i < 6; i++) {
    d();
    t.advance(100);
  }
  assert.strictEqual(calls, 0, "still typing");
  t.advance(250);
  assert.strictEqual(calls, 1);
  console.log("ok - six keystrokes 100 ms apart launch one fan-out, not six");
}
{
  const t = fakeTimers();
  let calls = 0;
  const d = debounce(() => calls++, 250, t);
  d();
  t.advance(300);
  d();
  t.advance(300);
  assert.strictEqual(calls, 2);
  console.log("ok - pauses longer than the delay each fire");
}
{
  const t = fakeTimers();
  let calls = 0;
  const d = debounce(() => calls++, 250, t);
  d();
  d.cancel();
  t.advance(1000);
  assert.strictEqual(calls, 0);
  d.flush();
  assert.strictEqual(calls, 0, "flush with nothing pending is a no-op");
  d();
  d.flush();
  assert.strictEqual(calls, 1);
  t.advance(1000);
  assert.strictEqual(calls, 1, "flush consumed the pending call");
  console.log("ok - cancel drops a pending call; flush runs it now, once");
}
