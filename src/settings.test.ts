import * as assert from "assert";
import { DEFAULT_SETTINGS, readSettings } from "./settings";

const from = (m: Record<string, unknown>) => readSettings((k) => m[k]);

{
  assert.deepStrictEqual(from({}), DEFAULT_SETTINGS);
  assert.deepStrictEqual(DEFAULT_SETTINGS, { pageSize: 200, maxConcurrency: 16, scanDepth: 2, excludeRepos: [] });
  console.log("ok - unset settings use the spec defaults");
}
{
  assert.deepStrictEqual(from({ pageSize: 0, maxConcurrency: 1e9, scanDepth: -3, excludeRepos: ["acme-libs", 4, null] }), {
    pageSize: 1, maxConcurrency: 64, scanDepth: 0, excludeRepos: ["acme-libs"],
  });
  assert.deepStrictEqual(from({ pageSize: "lots", maxConcurrency: NaN, scanDepth: 2.6, excludeRepos: "acme-*" }), {
    pageSize: 200, maxConcurrency: 16, scanDepth: 3, excludeRepos: [],
  });
  console.log("ok - out-of-range values clamp, wrong types fall back to defaults");
}
