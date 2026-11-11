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

// Edit text: grouping text objects into lines, and picking a look-alike font.
const { groupLines, similarFont } = require('./app.js');
const obj = (text, l, r, base, size = 10) => ({ text, l, r, b: base - 2, t: base + 8, size, m: [1, 0, 0, 1, l, base] });
const lines = groupLines([
  obj('world', 60, 90, 700), obj('Hello', 20, 55, 700),          // two pieces of one line, given out of order
  obj('*', 91, 95, 704, 6),                                       // a raised footnote mark: its own line
  obj('Second line', 20, 100, 680),
  obj('far away', 300, 360, 700),                                 // same height but a big gap: a separate line
  { ...obj('rotated', 20, 60, 600), m: [0, 1, -1, 0, 20, 600] }, // rotated text is skipped
]);
assert.deepStrictEqual(lines.map(L => L.text).sort(), ['*', 'Hello world', 'Second line', 'far away']);
assert.strictEqual(similarFont('NimbusRomNo9L-Medi'), 'Times-Bold');
assert.strictEqual(similarFont('Arial-ItalicMT'), 'Helvetica-Oblique');
assert.strictEqual(similarFont('CourierNewPSMT'), 'Courier');
assert.strictEqual(similarFont('ABCDEF+Calibri'), 'Helvetica');
console.log('edit ok');
