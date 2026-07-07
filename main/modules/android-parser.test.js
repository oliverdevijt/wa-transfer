const test = require('node:test');
const assert = require('node:assert/strict');
const { queryMessages, queryGroupMembers } = require('./android-parser');

test('queryMessages and queryGroupMembers are exported', () => {
  assert.equal(typeof queryMessages, 'function');
  assert.equal(typeof queryGroupMembers, 'function');
});
