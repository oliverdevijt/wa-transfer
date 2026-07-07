const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerFile } = require('./ios-backup-writer');

function fakeManifestDb() {
  const rows = new Map();
  return {
    prepare(sql) {
      if (sql.startsWith('INSERT OR REPLACE INTO Files')) {
        return { run: (fileID, domain, relativePath, flags, file) => rows.set(fileID, { domain, relativePath, flags, file }) };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    _rows: rows,
  };
}

test('registerFile computes the correct content-addressed fileID and writes bytes there', () => {
  const backupPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-backup-test-'));
  const db = fakeManifestDb();
  const domain = 'AppDomainGroup-group.net.whatsapp.WhatsApp.shared';
  const relativePath = 'Media/Message/test.jpg';
  const bytes = Buffer.from('fake jpeg bytes');

  const { fileID } = registerFile(backupPath, db, domain, relativePath, bytes);

  const expectedFileID = crypto.createHash('sha1').update(`${domain}-${relativePath}`).digest('hex');
  assert.equal(fileID, expectedFileID);

  const onDisk = path.join(backupPath, fileID.slice(0, 2), fileID);
  assert.equal(fs.readFileSync(onDisk).toString(), 'fake jpeg bytes');
  assert.ok(db._rows.has(fileID));
  assert.equal(db._rows.get(fileID).domain, domain);
  assert.equal(db._rows.get(fileID).relativePath, relativePath);

  fs.rmSync(backupPath, { recursive: true, force: true });
});
