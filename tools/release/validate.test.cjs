const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('./validate.cjs');
test('tag/version mismatch refuses the candidate', () => {
  assert.equal(validate('v0.3.10').androidVersionCode, 3);
  assert.throws(() => validate('v0.3.9'), /Tag/);
});
