const test = require('node:test');
const assert = require('node:assert/strict');
const { patchFileSize } = require('./manifest-patcher');
const { writeMBFile, readMBFile } = require('../utils/ios-plist');

function fakeManifestDb(existingBlob) {
  let stored = existingBlob;
  return {
    prepare(sql) {
      if (sql.startsWith('SELECT file FROM Files')) {
        return { get: () => ({ file: stored }) };
      }
      if (sql.startsWith('UPDATE Files SET file')) {
        return { run: (newBlob) => { stored = newBlob; } };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    _current: () => stored,
  };
}

test('patchFileSize updates Size/LastModified in the existing MBFile blob', () => {
  const original = writeMBFile({
    size: 100, mode: 33188, userID: 501, groupID: 501, protectionClass: 3,
    flags: 0, birth: 1000, lastModified: 1000, lastStatusChange: 1000,
    relativePath: 'ChatStorage.sqlite',
  });
  const db = fakeManifestDb(original);

  patchFileSize(db, 'some-file-id', 999);

  const updated = readMBFile(db._current());
  assert.equal(updated.size, 999);
  assert.equal(updated.relativePath, 'ChatStorage.sqlite'); // unchanged
  assert.ok(updated.lastModified > 1000); // bumped to "now"
});
