import assert from "node:assert/strict";
import { checkPrompt, clampParams } from "../lib/policy.js";

const cases = [
  ["a cute cat sitting on a laptop, flat illustration", true],
  ["動画編集者のためのシンプルな線画イラスト、青いパソコン", true],
  ["a beautiful woman on the beach", true],
  ["nude woman", true], // custom sexual-explicit は "nude" 単体では弾かない設定
  ["hentai style girl", false], // custom sexual-explicit
  ["小学生 全裸", false], // legal csam
  ["ｌｏｌｉ　ｎｕｄｅ", false], // 全角でも正規化して判定
  ["12 years old girl in bikini", false], // legal csam (年齢 regex + 水着)
  ["gore zombie", true], // gore rule は無効
  ["", false],
  ["x".repeat(1001), false],
];

for (const [prompt, expectOk] of cases) {
  const v = checkPrompt(prompt);
  assert.equal(v.ok, expectOk, `"${prompt.slice(0, 40)}" expected ok=${expectOk}, got ${JSON.stringify(v)}`);
}

assert.deepEqual(clampParams({ width: 4000, height: 100, steps: 999, seed: "42" }), {
  width: 1536,
  height: 256,
  steps: 50,
  seed: 42,
});
assert.deepEqual(clampParams({ width: 1000, height: "abc" }), { width: 1008, height: 1024, steps: null, seed: null });

console.log(`policy tests passed (${cases.length} prompts)`);
