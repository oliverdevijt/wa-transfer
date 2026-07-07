// Minimal binary-plist (bplist00) reader/writer for exactly one NSKeyedArchiver
// object graph shape: an MBFile record, as used by iOS backups' Manifest.db
// Files.file column. This is NOT a general bplist library — it only needs to
// handle this one fixed shape, verified against a real captured sample (see
// ios-plist.test.js, which round-trips through Python's plistlib as an
// independent oracle).
//
// Real reference sample captured this session (Manifest.db Files.file for
// ChatStorage.sqlite, parsed via Python plistlib):
//   $version: 100000, $archiver: NSKeyedArchiver, $top: { root: UID(1) }
//   $objects: [
//     '$null',
//     { LastModified, Flags, GroupID, $class: UID(3), LastStatusChange,
//       RelativePath: UID(2), Birth, Size, InodeNumber, Mode, UserID, ProtectionClass },
//     'ChatStorage.sqlite',
//     { $classname: 'MBFile', $classes: ['MBFile', 'NSObject'] }
//   ]
// The $objects array lists exactly the "archived object graph" (null, the
// MBFile dict, its RelativePath string, its class-info dict) — supporting
// objects like dict keys, $archiver's string value, etc. occupy their own
// slots in the flat bplist object table but are NOT listed inside $objects.

const MBFILE_KEYS = [
  'LastModified', 'Flags', 'GroupID', '$class', 'LastStatusChange',
  'RelativePath', 'Birth', 'Size', 'InodeNumber', 'Mode', 'UserID', 'ProtectionClass',
];
const CLASSINFO_KEYS = ['$classname', '$classes'];
const OUTER_KEYS = ['$version', '$archiver', '$top', '$objects'];

function encodeInt(n) {
  let bytes;
  if (n <= 0xff) bytes = 1;
  else if (n <= 0xffff) bytes = 2;
  else if (n <= 0xffffffff) bytes = 4;
  else bytes = 8;
  const marker = 0x10 | Math.log2(bytes);
  const buf = Buffer.alloc(1 + bytes);
  buf[0] = marker;
  if (bytes === 8) buf.writeBigUInt64BE(BigInt(n), 1);
  else buf.writeUIntBE(n, 1, bytes);
  return buf;
}

function encodeUID(index) {
  const bytes = index <= 0xff ? 1 : index <= 0xffff ? 2 : 4;
  const buf = Buffer.alloc(1 + bytes);
  buf[0] = 0x80 | (bytes - 1);
  buf.writeUIntBE(index, 1, bytes);
  return buf;
}

function encodeASCIIString(str) {
  const bytes = Buffer.from(str, 'ascii');
  const len = bytes.length;
  if (len < 15) {
    return Buffer.concat([Buffer.from([0x50 | len]), bytes]);
  }
  return Buffer.concat([Buffer.from([0x5f]), encodeInt(len), bytes]);
}

function refBytes(index, refSize) {
  const b = Buffer.alloc(refSize);
  b.writeUIntBE(index, 0, refSize);
  return b;
}

function encodeArray(refs, refSize) {
  const len = refs.length;
  const header = len < 15
    ? Buffer.from([0xa0 | len])
    : Buffer.concat([Buffer.from([0xaf]), encodeInt(len)]);
  return Buffer.concat([header, ...refs.map((r) => refBytes(r, refSize))]);
}

function encodeDict(pairs, refSize) {
  const len = pairs.length;
  const header = len < 15
    ? Buffer.from([0xd0 | len])
    : Buffer.concat([Buffer.from([0xdf]), encodeInt(len)]);
  const keys = pairs.map(([k]) => refBytes(k, refSize));
  const vals = pairs.map(([, v]) => refBytes(v, refSize));
  return Buffer.concat([header, ...keys, ...vals]);
}

function writeMBFile(fields) {
  const objects = [];
  const alloc = (buf) => { objects.push(buf); return objects.length - 1; };
  const refSize = 1; // this fixed shape never exceeds 255 objects

  const idxNull = alloc(Buffer.from([0x00]));
  const idxRelPath = alloc(encodeASCIIString(fields.relativePath));
  const idxMBFileClassname = alloc(encodeASCIIString('MBFile'));
  const idxNSObjectClassname = alloc(encodeASCIIString('NSObject'));

  const key = {};
  for (const k of [...MBFILE_KEYS, ...CLASSINFO_KEYS, ...OUTER_KEYS, 'root']) {
    if (!(k in key)) key[k] = alloc(encodeASCIIString(k));
  }

  const idxArchiverVal = alloc(encodeASCIIString('NSKeyedArchiver'));
  const idxVersionVal = alloc(encodeInt(100000));
  const idxLastModified = alloc(encodeInt(fields.lastModified));
  const idxFlags = alloc(encodeInt(fields.flags));
  const idxGroupID = alloc(encodeInt(fields.groupID));
  const idxLastStatusChange = alloc(encodeInt(fields.lastStatusChange));
  const idxBirth = alloc(encodeInt(fields.birth));
  const idxSize = alloc(encodeInt(fields.size));
  const idxInodeNumber = alloc(encodeInt(0));
  const idxMode = alloc(encodeInt(fields.mode));
  const idxUserID = alloc(encodeInt(fields.userID));
  const idxProtectionClass = alloc(encodeInt(fields.protectionClass));

  const idxClassesArray = alloc(encodeArray([idxMBFileClassname, idxNSObjectClassname], refSize));
  const idxClassInfo = alloc(encodeDict([
    [key['$classname'], idxMBFileClassname],
    [key['$classes'], idxClassesArray],
  ], refSize));

  // NSKeyedArchiver UIDs reference a *position within the $objects array*
  // (0=null, 1=MBFile dict, 2=relativePath string, 3=classinfo dict below),
  // NOT a raw bplist object-table index — confirmed against a real captured
  // Manifest.db blob, where object-table index 1 is actually the "$version"
  // key string, while $objects[1] is the MBFile dict.
  const OBJECTS_POS = { NULL: 0, MBFILE: 1, RELPATH: 2, CLASSINFO: 3 };
  const idxClassUID = alloc(encodeUID(OBJECTS_POS.CLASSINFO));
  const idxRelPathUID = alloc(encodeUID(OBJECTS_POS.RELPATH));

  const idxMBFileDict = alloc(encodeDict([
    [key['LastModified'], idxLastModified],
    [key['Flags'], idxFlags],
    [key['GroupID'], idxGroupID],
    [key['$class'], idxClassUID],
    [key['LastStatusChange'], idxLastStatusChange],
    [key['RelativePath'], idxRelPathUID],
    [key['Birth'], idxBirth],
    [key['Size'], idxSize],
    [key['InodeNumber'], idxInodeNumber],
    [key['Mode'], idxMode],
    [key['UserID'], idxUserID],
    [key['ProtectionClass'], idxProtectionClass],
  ], refSize));

  const idxRootUID = alloc(encodeUID(OBJECTS_POS.MBFILE));
  const idxTopDict = alloc(encodeDict([[key.root, idxRootUID]], refSize));
  const idxObjectsArray = alloc(encodeArray([idxNull, idxMBFileDict, idxRelPath, idxClassInfo], refSize));

  const idxOuterDict = alloc(encodeDict([
    [key['$version'], idxVersionVal],
    [key['$archiver'], idxArchiverVal],
    [key['$top'], idxTopDict],
    [key['$objects'], idxObjectsArray],
  ], refSize));

  return assembleBplist(objects, idxOuterDict, refSize);
}

function assembleBplist(objects, topObjectIndex, refSize) {
  const offsets = [];
  let cursor = 8; // after "bplist00" magic
  const chunks = [Buffer.from('bplist00', 'ascii')];
  for (const obj of objects) {
    offsets.push(cursor);
    chunks.push(obj);
    cursor += obj.length;
  }
  const offsetTableStart = cursor;
  const offsetIntSize = offsetTableStart <= 0xff ? 1 : offsetTableStart <= 0xffff ? 2 : 4;
  for (const off of offsets) {
    const b = Buffer.alloc(offsetIntSize);
    b.writeUIntBE(off, 0, offsetIntSize);
    chunks.push(b);
  }

  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(offsetIntSize, 6);
  trailer.writeUInt8(refSize, 7);
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(topObjectIndex), 16);
  trailer.writeBigUInt64BE(BigInt(offsetTableStart), 24);
  chunks.push(trailer);

  return Buffer.concat(chunks);
}

// -- Generic-enough bplist reader (object table walk) --------------------
// Handles the marker types this file's writer produces: null, int, UID,
// ASCII string, array, dict. Sufficient to read back what writeMBFile wrote
// (and any real iOS-produced MBFile blob, which uses the same marker types).

function parseBplist(buffer) {
  const trailer = buffer.subarray(buffer.length - 32);
  const offsetIntSize = trailer.readUInt8(6);
  const refSize = trailer.readUInt8(7);
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const topObjectIndex = Number(trailer.readBigUInt64BE(16));
  const offsetTableStart = Number(trailer.readBigUInt64BE(24));

  const offsets = [];
  for (let i = 0; i < numObjects; i++) {
    offsets.push(buffer.readUIntBE(offsetTableStart + i * offsetIntSize, offsetIntSize));
  }

  const cache = new Map();
  function readObjectAt(index) {
    if (cache.has(index)) return cache.get(index);
    const offset = offsets[index];
    const marker = buffer[offset];
    const type = marker & 0xf0;
    const info = marker & 0x0f;
    let result;

    if (marker === 0x00) {
      result = null;
    } else if (type === 0x10) {
      const bytes = 1 << info;
      result = Number(buffer.readUIntBE(offset + 1, bytes));
    } else if (type === 0x80) {
      const bytes = info + 1;
      result = { __uid: buffer.readUIntBE(offset + 1, bytes) };
    } else if (type === 0x50) {
      let len = info;
      let pos = offset + 1;
      if (info === 0x0f) {
        const lenMarker = buffer[pos];
        const lenBytes = 1 << (lenMarker & 0x0f);
        len = buffer.readUIntBE(pos + 1, lenBytes);
        pos += 1 + lenBytes;
      }
      result = buffer.toString('ascii', pos, pos + len);
    } else if (type === 0xa0) {
      let len = info;
      let pos = offset + 1;
      if (info === 0x0f) {
        const lenMarker = buffer[pos];
        const lenBytes = 1 << (lenMarker & 0x0f);
        len = buffer.readUIntBE(pos + 1, lenBytes);
        pos += 1 + lenBytes;
      }
      const refs = [];
      for (let i = 0; i < len; i++) {
        refs.push(buffer.readUIntBE(pos + i * refSize, refSize));
      }
      result = refs.map((r) => readObjectAt(r));
    } else if (type === 0xd0) {
      let len = info;
      let pos = offset + 1;
      if (info === 0x0f) {
        const lenMarker = buffer[pos];
        const lenBytes = 1 << (lenMarker & 0x0f);
        len = buffer.readUIntBE(pos + 1, lenBytes);
        pos += 1 + lenBytes;
      }
      const keyRefs = [];
      for (let i = 0; i < len; i++) keyRefs.push(buffer.readUIntBE(pos + i * refSize, refSize));
      pos += len * refSize;
      const valRefs = [];
      for (let i = 0; i < len; i++) valRefs.push(buffer.readUIntBE(pos + i * refSize, refSize));

      const dict = {};
      for (let i = 0; i < len; i++) {
        dict[readObjectAt(keyRefs[i])] = readObjectAt(valRefs[i]);
      }
      result = dict;
    } else {
      throw new Error(`Unsupported bplist marker 0x${marker.toString(16)} at object ${index}`);
    }

    cache.set(index, result);
    return result;
  }

  return { topObject: readObjectAt(topObjectIndex), readObjectAt };
}

function readMBFile(buffer) {
  const { topObject } = parseBplist(buffer);
  // NSKeyedArchiver UIDs are positions within the already-resolved $objects
  // array, not raw bplist object-table indices — see the note in writeMBFile.
  const objects = topObject.$objects;
  const resolveUid = (uid) => objects[uid.__uid];

  const mbFile = resolveUid(topObject.$top.root);

  return {
    size: mbFile.Size,
    mode: mbFile.Mode,
    userID: mbFile.UserID,
    groupID: mbFile.GroupID,
    protectionClass: mbFile.ProtectionClass,
    flags: mbFile.Flags,
    birth: mbFile.Birth,
    lastModified: mbFile.LastModified,
    lastStatusChange: mbFile.LastStatusChange,
    relativePath: resolveUid(mbFile.RelativePath),
  };
}

module.exports = { writeMBFile, readMBFile };
