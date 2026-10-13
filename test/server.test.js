const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { app, normalize, validUsername, validDisplayName, validEncryptedMessage } = require('../server');

test('normalization trims whitespace and case-folds usernames', () => {
  assert.equal(normalize('  Mayank   Kumar '), 'mayank kumar');
  assert.equal(normalize(null), '');
});

test('username validation enforces the documented public format', () => {
  assert.equal(validUsername('mayank_23'), true);
  assert.equal(validUsername('mayank.k'), true);
  assert.equal(validUsername('ab'), false);
  assert.equal(validUsername('a'.repeat(25)), false);
  assert.equal(validUsername('two words'), false);
  assert.equal(validUsername('<admin>'), false);
  assert.equal(validUsername('UPPERCASE'), true);
});

test('display names are bounded and reject markup delimiters', () => {
  assert.equal(validDisplayName('Mayank Kumar'), true);
  assert.equal(validDisplayName('A'), false);
  assert.equal(validDisplayName('x'.repeat(41)), false);
  assert.equal(validDisplayName('<admin>'), false);
});

test('encrypted message validation accepts ciphertext and 96-bit IV encoding', () => {
  assert.equal(validEncryptedMessage({ ciphertext: 'AQIDBA', iv: 'abcdefghijklmnop' }), true);
  assert.equal(validEncryptedMessage({ ciphertext: '', iv: 'abcdefghijklmnop' }), false);
  assert.equal(validEncryptedMessage({ ciphertext: 'abc', iv: 'short' }), false);
  assert.equal(validEncryptedMessage({ ciphertext: 'a'.repeat(65537), iv: 'abcdefghijklmnop' }), false);
  assert.equal(validEncryptedMessage({ ciphertext: 'abc', iv: 'abcdefghijklmnop', text: 'extra plaintext' }), true);
});

test('health and config endpoints do not expose service-role credentials', async (t) => {
  const srv = http.createServer(app);
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => srv.close(() => resolve())));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const healthResponse = await fetch(base + '/health');
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.service, 'fb-chat-app');
  assert.equal(typeof health.authConfigured, 'boolean');
  const configResponse = await fetch(base + '/api/config');
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json();
  assert.equal(typeof config.configured, 'boolean');
  assert.equal(Object.hasOwn(config, 'supabaseServiceRoleKey'), false);
  assert.equal(Object.hasOwn(config, 'serviceRoleKey'), false);
});

test('profile endpoint fails closed while database setup is absent', async (t) => {
  const srv = http.createServer(app);
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => srv.close(() => resolve())));
  const response = await fetch('http://127.0.0.1:' + srv.address().port + '/api/me');
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error, 'SERVER_NOT_CONFIGURED');
});
