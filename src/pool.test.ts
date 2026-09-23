import * as assert from "assert";
import { abortError, isAbortError, runPool } from "./pool";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const values = <R>(rs: PromiseSettledResult<R>[]) => rs.map((r) => (r.status === "fulfilled" ? r.value : "rejected"));

(async () => {
  {
    let active = 0;
    let peak = 0;
    const rs = await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await tick(5);
      active--;
      return n * 10;
    }, new AbortController().signal);
    assert.strictEqual(peak, 3);
    assert.deepStrictEqual(values(rs), [10, 20, 30, 40, 50, 60, 70]);
    console.log("ok - never exceeds the limit; results keep input order");
  }
  {
    const rs = await runPool(["acme-web", "acme-libs", "acme-api"], 2, async (name) => {
      if (name === "acme-libs") throw new Error("shallow clone");
      return name;
    }, new AbortController().signal);
    assert.deepStrictEqual(values(rs), ["acme-web", "rejected", "acme-api"]);
    console.log("ok - one failing item does not fail the others");
  }
  {
    const ctl = new AbortController();
    let started = 0;
    const rs = await runPool([1, 2, 3, 4, 5], 1, async (n) => {
      started++;
      if (n === 1) ctl.abort();
      return n;
    }, ctl.signal);
    assert.strictEqual(started, 1, "no new work starts after abort");
    assert.ok(rs.slice(1).every((r) => r.status === "rejected" && isAbortError(r.reason)));
    console.log("ok - abort stops scheduling; unstarted items settle as AbortError");
  }
  {
    assert.deepStrictEqual(await runPool([], 4, async () => 1, new AbortController().signal), []);
    assert.deepStrictEqual(values(await runPool([1, 2], 0, async (n) => n, new AbortController().signal)), [1, 2], "limit 0 behaves as 1");
    assert.ok(isAbortError(abortError()) && !isAbortError(new Error("x")) && !isAbortError("AbortError"));
    console.log("ok - empty input, a zero limit, and abort helpers");
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
