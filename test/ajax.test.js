const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

test('OmAjax module exposes standard HTTP methods', () => {
  const ajax = require('../js/ajax.js');
  assert.strictEqual(typeof ajax.request, 'function');
  assert.strictEqual(typeof ajax.get, 'function');
  assert.strictEqual(typeof ajax.post, 'function');
  assert.strictEqual(typeof ajax.put, 'function');
  assert.strictEqual(typeof ajax.delete, 'function');
  assert.strictEqual(typeof ajax.checkConnectivity, 'function');
  assert.strictEqual(typeof ajax.ping, 'function');
  assert.strictEqual(typeof ajax.checkFirebaseHealth, 'function');
});

test('OmAjax handles HTTP GET and POST against local server', async () => {
  const ajax = require('../js/ajax.js');

  // Start a lightweight test HTTP server
  const server = http.createServer((req, res) => {
    if (req.url === '/ping' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(req.method === 'HEAD' ? '' : JSON.stringify({ status: 'pong' }));
    } else if (req.url === '/echo' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Test GET
    const getRes = await ajax.get(`${baseUrl}/ping`);
    assert.deepStrictEqual(getRes, { status: 'pong' });

    // Test POST
    const postPayload = { code: '123456', action: 'test' };
    const postRes = await ajax.post(`${baseUrl}/echo`, postPayload);
    assert.deepStrictEqual(postRes, postPayload);

    // Test Ping Latency
    const latency = await ajax.ping(`${baseUrl}/ping`);
    assert.ok(latency >= 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
