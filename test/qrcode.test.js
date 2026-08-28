const test = require('node:test');
const assert = require('node:assert');
const qrcode = require('../js/qrcode.js');

test('OmQRCode generates valid SVG string for share URLs', () => {
  const url = 'https://omshare.netlify.app/?code=123456';
  const svg = qrcode.generateSvg(url, { margin: 4 });

  assert.ok(typeof svg === 'string');
  assert.ok(svg.includes('<svg'));
  assert.ok(svg.includes('<rect'));
  assert.ok(svg.endsWith('</svg>'));
});
