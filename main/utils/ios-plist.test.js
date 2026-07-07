const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeMBFile, readMBFile } = require('./ios-plist');

test('writeMBFile produces a bplist that Python plistlib parses back correctly', () => {
  const fields = {
    size: 1032192,
    mode: 33188,
    userID: 501,
    groupID: 501,
    protectionClass: 3,
    flags: 0,
    birth: 1783280716,
    lastModified: 1783409959,
    lastStatusChange: 1783409612,
    relativePath: 'ChatStorage.sqlite',
  };
  const buf = writeMBFile(fields);

  const tmp = path.join(os.tmpdir(), `mbfile-test-${Date.now()}.plist`);
  fs.writeFileSync(tmp, buf);
  const script = `
import plistlib, sys
with open(sys.argv[1], 'rb') as f:
    d = plistlib.load(f)
o = d['$objects']
print(o[1]['Size'], o[1]['Mode'], o[1]['UserID'], o[1]['GroupID'],
      o[1]['ProtectionClass'], o[1]['Flags'], o[1]['Birth'],
      o[1]['LastModified'], o[1]['LastStatusChange'], o[2])
`;
  const out = execFileSync('python3', ['-c', script, tmp], { encoding: 'utf8' }).trim();
  fs.unlinkSync(tmp);
  assert.equal(out, '1032192 33188 501 501 3 0 1783280716 1783409959 1783409612 ChatStorage.sqlite');
});

test('writeMBFile handles a relativePath longer than 15 chars (extended string length encoding)', () => {
  const fields = {
    size: 500, mode: 33188, userID: 501, groupID: 501, protectionClass: 3,
    flags: 0, birth: 100, lastModified: 200, lastStatusChange: 150,
    relativePath: 'Media/Message/some-fairly-long-filename-that-exceeds-fifteen-chars.jpg',
  };
  const buf = writeMBFile(fields);
  const tmp = path.join(os.tmpdir(), `mbfile-test-${Date.now()}-long.plist`);
  fs.writeFileSync(tmp, buf);
  const out = execFileSync('python3', ['-c', `
import plistlib, sys
with open(sys.argv[1], 'rb') as f:
    d = plistlib.load(f)
print(d['$objects'][2])
`, tmp], { encoding: 'utf8' }).trim();
  fs.unlinkSync(tmp);
  assert.equal(out, fields.relativePath);
});

test('readMBFile parses a real captured MBFile blob correctly', () => {
  const fields = {
    size: 500, mode: 33188, userID: 501, groupID: 501, protectionClass: 3,
    flags: 0, birth: 100, lastModified: 200, lastStatusChange: 150,
    relativePath: 'Media/Message/foo.jpg',
  };
  const buf = writeMBFile(fields);
  const parsed = readMBFile(buf);
  assert.deepEqual(parsed, fields);
});
