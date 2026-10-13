const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, validName, validMessage, pairKey } = require('../server');

test('normalize trims and collapses whitespace without case sensitivity', () => {
  assert.equal(normalize('  Mayank   Kumar '), 'mayank kumar');
});

test('display names are length-limited and reject markup delimiters', () => {
  assert.equal(validName('Mayank'), true);
  assert.equal(validName('A'), false);
  assert.equal(validName('x'.repeat(33)), false);
  assert.equal(validName('<admin>'), false);
});

test('message validation rejects blank and overlong messages', () => {
  assert.equal(validMessage(' hello '), true);
  assert.equal(validMessage('   '), false);
  assert.equal(validMessage('x'.repeat(4001)), false);
});

test('direct-message pair keys are stable regardless of participant order', () => {
  assert.equal(pairKey('Mayank', 'Sana'), pairKey('Sana', 'Mayank'));
});
