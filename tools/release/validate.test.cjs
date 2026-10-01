const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validate } = require('./validate.cjs');
test('tag/version mismatch refuses the candidate', () => {
  assert.ok(validate('v' + validate().version).androidVersionCode >= 3);
  assert.throws(() => validate('v' + validate().version + '-wrong'), /Tag/);
});
