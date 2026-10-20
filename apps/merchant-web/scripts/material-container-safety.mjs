import { crc32, inflateRawSync } from 'node:zlib';

const maxExpandedBytes = 32 * 1024 * 1024;
const modernTypes = new Map([
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'word/document.xml'],
  [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'ppt/presentation.xml',
  ],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xl/workbook.xml'],
]);
const legacyTypes = new Map([
  ['application/msword', ['WordDocument']],
  ['application/vnd.ms-powerpoint', ['PowerPoint Document']],
  ['application/vnd.ms-excel', ['Workbook', 'Book']],
]);
function invalid() {
  throw new Error('Unsupported or unsafe document container');
}

// Validate and actually decompress each ZIP entry within a fixed budget before
// calling native Office parsers. SecurityLimits is not a universal OOXML guard.
// No entry is written to disk, opened as a program, or recursively extracted.
function validateOfficeZip(bytes, requiredPart) {
  let end = bytes.length - 22;
  const earliest = Math.max(0, bytes.length - 65557);
  while (end >= earliest && bytes.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < earliest || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) invalid();
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) invalid();
  const count = bytes.readUInt16LE(end + 10);
  if (!count || count > 1000 || count !== bytes.readUInt16LE(end + 8)) invalid();
  const directorySize = bytes.readUInt32LE(end + 12);
  let cursor = bytes.readUInt32LE(end + 16);
  const directoryStart = cursor;
  if (directorySize === 0xffffffff || cursor === 0xffffffff || cursor + directorySize !== end)
    invalid();
  const seen = new Set();
  const payloadRanges = [];
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) invalid();
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || !nameLength || flags & 0x2041 || ![0, 8].includes(method)) invalid();
    if (
      bytes.readUInt16LE(cursor + 34) !== 0 ||
      ((bytes.readUInt32LE(cursor + 38) >>> 16) & 0xf000) === 0xa000
    )
      invalid();
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    if (
      /[\u0000-\u001f\\:]/u.test(name) ||
      name.startsWith('/') ||
      name.split('/').includes('..') ||
      seen.has(name)
    )
      invalid();
    seen.add(name);
    if (/vbaProject\.bin$|(?:^|\/)embeddings\//iu.test(name)) invalid();
    if (
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      uncompressed / Math.max(compressed, 1) > 100
    )
      invalid();
    expanded += uncompressed;
    if (expanded > maxExpandedBytes) invalid();
    if (local + 30 > directoryStart || bytes.readUInt32LE(local) !== 0x04034b50) invalid();
    if (
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt16LE(local + 26) !== nameLength
    )
      invalid();
    const dataStart = local + 30 + nameLength + bytes.readUInt16LE(local + 28);
    const dataEnd = dataStart + compressed;
    if (
      dataEnd > directoryStart ||
      !bytes.subarray(local + 30, local + 30 + nameLength).equals(nameBytes)
    )
      invalid();
    payloadRanges.push([local, dataEnd]);
    const stored = bytes.subarray(dataStart, dataEnd);
    const data =
      method === 8
        ? inflateRawSync(stored, { maxOutputLength: Math.min(maxExpandedBytes, uncompressed + 1) })
        : stored;
    if (data.length !== uncompressed || crc32(data) !== checksum) invalid();
    if (/\.(?:xml|rels)$/iu.test(name)) {
      // OOXML never needs DTDs or entities. Reject both UTF-8 and UTF-16 forms.
      const xml = data.toString('utf8').replaceAll('\0', '');
      if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(xml)) invalid();
      let depth = 0,
        tags = 0;
      for (const match of xml.matchAll(/<(\/?)([A-Za-z_][\w:.-]*)\b[^>]*?(\/?)>/gu)) {
        tags += 1;
        if (tags > 100000) invalid();
        if (match[1]) depth -= 1;
        else if (!match[3]) depth += 1;
        if (depth > 64 || depth < 0) invalid();
      }
      if (name === '[Content_Types].xml' && /macroEnabled|vbaProject/iu.test(xml)) invalid();
      if (/^xl\/worksheets\/[^/]+\.xml$/u.test(name)) {
        // Sparse worksheets can otherwise allocate a huge rectangular range.
        let cells = 0,
          maxRow = 0,
          maxColumn = 0;
        for (const match of xml.matchAll(/<(?:\w+:)?c\b[^>]*\br=["']([A-Z]+)(\d+)["']/gu)) {
          cells += 1;
          let column = 0;
          for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
          maxRow = Math.max(maxRow, Number(match[2]));
          maxColumn = Math.max(maxColumn, column);
          if (cells > 20000 || maxRow * maxColumn > 20000) invalid();
        }
        for (const match of xml.matchAll(
          /<(?:\w+:)?dimension\b[^>]*\bref=["'][^"']*?([A-Z]+)(\d+)["']/gu,
        )) {
          let column = 0;
          for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
          if (Number(match[2]) * column > 20000) invalid();
        }
      }
    }
    cursor = next;
  }
  if (cursor !== end || !seen.has('[Content_Types].xml') || !seen.has(requiredPart)) invalid();
  payloadRanges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < payloadRanges.length; index += 1)
    if (payloadRanges[index][0] < payloadRanges[index - 1][1]) invalid();
}

// Follow only the bounded compound-file directory/FAT, not arbitrary embedded
// streams. This identifies legacy Office subtypes and encrypted/macro containers.
function validateLegacyOffice(bytes, expectedNames) {
  if (bytes.length < 512 || !bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')))
    invalid();
  const shift = bytes.readUInt16LE(30);
  if (![9, 12].includes(shift) || bytes.readUInt16LE(28) !== 0xfffe) invalid();
  const sectorSize = 2 ** shift;
  const sectorCount = Math.floor(bytes.length / sectorSize) - 1;
  const fatCount = bytes.readUInt32LE(44);
  // A 10 MB input cannot need the >109 FAT sectors of a DIFAT extension.
  if (!fatCount || fatCount > 109 || bytes.readUInt32LE(72) !== 0) invalid();
  const sector = (id) => {
    if (id >= sectorCount) invalid();
    return bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize);
  };
  const fats = [];
  for (let index = 0; index < fatCount; index += 1)
    fats.push(sector(bytes.readUInt32LE(76 + index * 4)));
  const fat = Buffer.concat(fats);
  let current = bytes.readUInt32LE(48);
  const visited = new Set();
  const names = new Set();
  while (current !== 0xfffffffe) {
    if (visited.has(current) || visited.size >= sectorCount || current * 4 + 4 > fat.length)
      invalid();
    visited.add(current);
    const directory = sector(current);
    for (let offset = 0; offset < sectorSize; offset += 128) {
      const kind = directory[offset + 66];
      if (!kind) continue;
      const length = directory.readUInt16LE(offset + 64);
      if (length < 2 || length > 64 || length % 2) invalid();
      const name = directory.subarray(offset, offset + length - 2).toString('utf16le');
      if (/^(?:VBA|_VBA_PROJECT|EncryptionInfo|EncryptedPackage)$/iu.test(name)) invalid();
      if (kind === 2) names.add(name);
    }
    current = fat.readUInt32LE(current * 4);
  }
  if (!expectedNames.some((name) => names.has(name))) invalid();
}

export function validateContainer(bytes, mime) {
  if (modernTypes.has(mime)) validateOfficeZip(bytes, modernTypes.get(mime));
  else if (legacyTypes.has(mime)) validateLegacyOffice(bytes, legacyTypes.get(mime));
  else if (!['application/pdf', 'text/plain', 'text/csv', 'text/markdown'].includes(mime))
    invalid();
}
