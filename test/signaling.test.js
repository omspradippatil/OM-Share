const test = require('node:test');
const assert = require('node:assert');
const HybridSignaling = require('../js/signaling.js');

test('HybridSignalingManager initializes cleanly with error resilience', () => {
  const signaling = new HybridSignaling();
  assert.ok(signaling);
  assert.strictEqual(typeof signaling.createTransfer, 'function');
  assert.strictEqual(typeof signaling.joinTransfer, 'function');
  assert.strictEqual(typeof signaling.listenSession, 'function');
  assert.strictEqual(typeof signaling.sendOffer, 'function');
  assert.strictEqual(typeof signaling.sendAnswer, 'function');
  assert.strictEqual(typeof signaling.sendCandidate, 'function');
  assert.strictEqual(typeof signaling.cleanup, 'function');
});
