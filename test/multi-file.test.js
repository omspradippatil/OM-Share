const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');

test('Multi-file packaging creates a valid zip archive with nested directories', async () => {
  const zip = new JSZip();

  const mockFiles = [
    { path: 'documents/report.pdf', content: 'PDF_DUMMY_DATA_123' },
    { path: 'images/nested/photo.jpg', content: 'JPEG_DUMMY_DATA_456' },
    { path: 'readme.txt', content: 'Hello OmShare Multi-File' }
  ];

  for (const item of mockFiles) {
    zip.file(item.path, item.content);
  }

  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  assert.ok(zipBuffer.length > 0, 'Zip buffer must not be empty');

  // Verify extraction / integrity
  const unzipped = await JSZip.loadAsync(zipBuffer);
  assert.ok(unzipped.file('documents/report.pdf'), 'Must contain documents/report.pdf');
  assert.ok(unzipped.file('images/nested/photo.jpg'), 'Must contain images/nested/photo.jpg');
  assert.ok(unzipped.file('readme.txt'), 'Must contain readme.txt');

  const readmeContent = await unzipped.file('readme.txt').async('string');
  assert.strictEqual(readmeContent, 'Hello OmShare Multi-File');
});

test('Multi-file batch size and formatting calculations', () => {
  const mockItems = [
    { name: 'file1.pdf', path: 'file1.pdf', size: 1048576 }, // 1 MB
    { name: 'video.mp4', path: 'video.mp4', size: 10485760 } // 10 MB
  ];

  const totalSize = mockItems.reduce((acc, f) => acc + f.size, 0);
  assert.strictEqual(totalSize, 11534336); // 11 MB
  assert.strictEqual(mockItems.length, 2);
});
