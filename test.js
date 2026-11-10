// node paperbench/test.js
const assert = require('assert');
const { parseRanges, isProResponse } = require('./app.js');

const cfg = { storeId: 1, productId: 2 };
const ok = { valid: true, license_key: { status: 'active' }, meta: { store_id: 1, product_id: 2 } };
assert.ok(isProResponse(ok, cfg));
assert.ok(!isProResponse({ ...ok, license_key: { status: 'expired' } }, cfg), 'lapsed subscription');
assert.ok(!isProResponse({ ...ok, meta: { store_id: 9, product_id: 2 } }, cfg), 'key from another store');
assert.ok(!isProResponse({ ...ok, valid: false }, cfg), 'invalid');
assert.ok(!isProResponse(ok, { storeId: 0, productId: 0 }), 'not configured');
assert.ok(!isProResponse({ error: 'license_key not found.' }, cfg));

assert.deepStrictEqual(parseRanges('1-3, 5', 5), [0, 1, 2, 4]);
assert.deepStrictEqual(parseRanges('2', 2), [1]);
assert.deepStrictEqual(parseRanges(' 1 - 2 ,', 3), [0, 1]);
for (const bad of ['0', '6', '3-1', 'abc', '', '1-9']) assert.throws(() => parseRanges(bad, 5), bad);
console.log('ok');
