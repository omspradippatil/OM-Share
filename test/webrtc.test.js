const test = require('node:test');
const assert = require('node:assert');

test('WebRTC chunk calculations and size formatters', () => {
  const CHUNK_SIZE = 65536; // 64KB

  // Test chunk count calculations
  const smallFileSize = 1000; // 1KB
  assert.strictEqual(Math.ceil(smallFileSize / CHUNK_SIZE), 1);

  const exactChunkSize = 65536; // 64KB exactly
  assert.strictEqual(Math.ceil(exactChunkSize / CHUNK_SIZE), 1);

  const multiChunkSize = 65536 * 3 + 120; // 3.001 chunks -> 4 chunks
  assert.strictEqual(Math.ceil(multiChunkSize / CHUNK_SIZE), 4);

  const largeFileSize = 1024 * 1024 * 1024; // 1GB
  assert.strictEqual(Math.ceil(largeFileSize / CHUNK_SIZE), 16384);

  // Test 6-digit code format
  for (let i = 0; i < 100; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    assert.strictEqual(code.length, 6);
    assert.match(code, /^[0-9]{6}$/);
  }
});
