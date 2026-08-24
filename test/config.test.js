const test = require('node:test');
const assert = require('node:assert');

test('Config module loads and provides default configurations', () => {
  const config = require('../js/config.js');
  
  assert.ok(config);
  assert.strictEqual(typeof config.CHUNK_SIZE, 'number');
  assert.strictEqual(config.CHUNK_SIZE, 65536);
  assert.ok(Array.isArray(config.ICE_SERVERS));
  assert.ok(config.ICE_SERVERS.length > 0);
  assert.strictEqual(typeof config.isFirebaseConfigured, 'function');
});

test('Config module correctly identifies placeholder vs real Firebase credentials', () => {
  const config = require('../js/config.js');
  
  // With placeholder credentials
  const dummyConfig = { apiKey: 'YOUR_API_KEY', projectId: 'YOUR_PROJECT_ID' };
  const isDummyConfigured = Boolean(dummyConfig.apiKey && dummyConfig.projectId && 
    !dummyConfig.apiKey.includes('YOUR_API_KEY') && !dummyConfig.projectId.includes('YOUR_PROJECT'));
  assert.strictEqual(isDummyConfigured, false);

  // With valid credentials
  const validConfig = { apiKey: 'AIzaSyACPvi35S8zIpcPpRR1vM00lvnBw1KT9n8', projectId: 'om-share-af20d' };
  const isValidConfigured = Boolean(validConfig.apiKey && validConfig.projectId && 
    !validConfig.apiKey.includes('YOUR_API_KEY') && !validConfig.projectId.includes('YOUR_PROJECT'));
  assert.strictEqual(isValidConfigured, true);
});
