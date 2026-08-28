const test = require('node:test');
const assert = require('node:assert');
const qrcode = require('../js/qrcode.js');

test('OmQRCode generates valid SVG string for share URLs', () => {
  const url = 'https://omshare.netlify.app/?code=123456';
  const svg = qrcode.generateSvg(url, { size: 200, margin: 4 });

  assert.ok(typeof svg === 'string');
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes('<rect'));
  assert.ok(svg.endsWith('</svg>'));
});
