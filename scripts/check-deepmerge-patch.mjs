import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Resolve the actual Expo consumer, not an unrelated hoisted copy.
const mobile = createRequire(new URL("../apps/mobile/package.json", import.meta.url));
const expo = createRequire(mobile.resolve("expo/package.json"));
const config = createRequire(expo.resolve("@expo/config/package.json"));
const merge = config("deepmerge");
assert.equal(config("deepmerge/package.json").version, "4.3.1");
for (const input of [
  JSON.parse(
    '{"__proto__":{"poisoned":true},"constructor":{"prototype":{"poisoned":true}},"prototype":{"poisoned":true}}',
  ),
  Object.assign(Object.create(null), JSON.parse('{"__proto__":{"poisoned":true}}')),
]) {
  for (const value of [
    merge(input, {}),
    merge({}, input),
    merge(input, input),
    merge.all([{}, input]),
    merge({ nested: input }, {}).nested,
  ]) {
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.equal(value.poisoned, undefined);
    assert.equal(Object.hasOwn(value, "__proto__"), false);
    assert.equal(Object.hasOwn(value, "constructor"), false);
    assert.equal(Object.hasOwn(value, "prototype"), false);
  }
}
assert.deepEqual(merge({ list: [1], nested: { a: 1 } }, { list: [2], nested: { b: 2 } }), {
  list: [1, 2],
  nested: { a: 1, b: 2 },
});
assert.equal({}.poisoned, undefined);
