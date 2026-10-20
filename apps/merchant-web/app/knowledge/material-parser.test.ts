import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { validateContainer } from '../../scripts/material-container-safety.mjs';
import { MaterialParseError, materialMime, materialTypes, parseMaterial } from './material-parser';

// All downloaded Office fixtures are public, synthetic Apache POI test files.
// SOURCES.txt pins their revision, original path, SHA-256 and Apache 2.0 notices.
const fixture = (name: string) => readFile(join(import.meta.dirname, 'fixtures', name));
const docxMime = materialTypes.docx;

function pdf(text?: string): Buffer {
  const content = text ? `BT /F1 18 Tf 40 100 Td (${text}) Tj ET` : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

interface ZipEntry {
  name: string;
  content: string;
  flags?: number;
  advertisedSize?: number;
}
function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.content);
    const compressed = deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags ?? 0, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.advertisedSize ?? data.length, 22);
    header.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(entry.flags ?? 0, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc32(data), 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(entry.advertisedSize ?? data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    locals.push(header, name, compressed);
    central.push(record, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const wordEntries: ZipEntry[] = [
  { name: '[Content_Types].xml', content: '<Types />' },
  { name: 'word/document.xml', content: '<document>Test material</document>' },
];

describe('real native material parsing (no mocked extractors)', () => {
  it.each([
    [
      'simple.doc',
      'simple file created with Word 97-SR2',
      '4876e828e62d490fa188c7c4e47013e2e0dfdf02f5903dfd374bc0d2b2049ca1',
    ],
    [
      'SampleDoc.docx',
      'I am a test document',
      'ea2c517bd7be4628887eb97f630334b93b894f4522d2c0adae263e602d76df92',
    ],
    [
      'basic_test_ppt_file.ppt',
      'This is a test title',
      'e8fd4c38ad72ce3735acbca0b60dd5870fb60f819c169e3947d166f4f1bcc79d',
    ],
    [
      'SampleShow.pptx',
      'Title of the first slide',
      'bfb4b2f07c9233afd2f32aa5781d849d0c7d225bf03721a10becf487b481d828',
    ],
    [
      'testEXCEL_95.xls',
      'Numbers and their Squares',
      'ac0ce3a2eff43e32e56d6b789df6aaa1645ae846d22fa3a2fe3057391d0f1cae',
    ],
    [
      'sample.xlsx',
      'Lorem 111',
      '7c88883ea9ff72d8f90239cb1a5f5d9744014b611d9b1588a090ba7629a381de',
    ],
  ])(
    'extracts actual %s fixture',
    async (name, expected, sha256) => {
      const bytes = await fixture(name!);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);
      await expect(parseMaterial(name!, bytes)).resolves.toContain(expected);
    },
    25000,
  );

  it('extracts the text layer of a valid generated PDF using bundled PDFium', async () => {
    await expect(parseMaterial('synthetic.pdf', pdf('Retail shipping policy'))).resolves.toContain(
      'Retail shipping policy',
    );
  }, 25000);

  it.each(['txt', 'csv', 'md'])(
    'extracts UTF-8 %s without converting it to executable content',
    async (extension) => {
      await expect(
        parseMaterial(`retail.${extension}`, Buffer.from('基础资料\n商品,价格\n测试商品,99')),
      ).resolves.toContain('测试商品');
    },
    25000,
  );

  it('rejects empty/scanned PDF instead of inventing OCR text', async () => {
    await expect(parseMaterial('scan.pdf', pdf())).rejects.toThrow(/无可提取文字/u);
    await expect(parseMaterial('image-only.pdf', await fixture('image-only.pdf'))).rejects.toThrow(
      /无可提取文字/u,
    );
  }, 25000);

  it('rejects corrupt and genuinely encrypted PDFs without exposing native errors', async () => {
    await expect(
      parseMaterial('broken.pdf', Buffer.from('%PDF-1.4\n/Encrypt 9 0 R')),
    ).rejects.toThrow(MaterialParseError);
    await expect(parseMaterial('encrypted.pdf', await fixture('encrypted.pdf'))).rejects.toThrow(
      /无法解析/u,
    );
  }, 25000);

  it('rejects oversized extracted text rather than silently truncating knowledge', async () => {
    await expect(parseMaterial('large.txt', Buffer.from('测'.repeat(24001)))).rejects.toThrow(
      /24000/u,
    );
  }, 25000);

  it('rejects a renamed Office file despite sharing ZIP or OLE signatures', async () => {
    await expect(parseMaterial('wrong.pptx', await fixture('SampleDoc.docx'))).rejects.toThrow(
      MaterialParseError,
    );
    await expect(parseMaterial('wrong.xls', await fixture('simple.doc'))).rejects.toThrow(
      MaterialParseError,
    );
  }, 25000);

  it('allows at most two active native children and releases slots afterwards', async () => {
    const first = parseMaterial('one.txt', Buffer.from('one test'));
    const second = parseMaterial('two.txt', Buffer.from('two test'));
    await expect(parseMaterial('three.txt', Buffer.from('three test'))).rejects.toThrow(/繁忙/u);
    await expect(Promise.all([first, second])).resolves.toEqual(['one test', 'two test']);
    await expect(parseMaterial('four.txt', Buffer.from('four test'))).resolves.toBe('four test');
  }, 25000);
});

describe('Office preflight actually enforces bounds before native parsing', () => {
  it('accepts minimal subtype-correct ZIP containers', () => {
    expect(() => validateContainer(zip(wordEntries), docxMime)).not.toThrow();
  });
  it.each([
    ['wrong subtype', wordEntries, materialTypes.xlsx],
    ['duplicate name', [...wordEntries, wordEntries[1]!], docxMime],
    ['path traversal', [...wordEntries, { name: '../leak.xml', content: 'x' }], docxMime],
    ['absolute path', [...wordEntries, { name: '/etc/leak.xml', content: 'x' }], docxMime],
    [
      'encrypted entry',
      [...wordEntries, { name: 'word/encrypted.xml', content: 'x', flags: 1 }],
      docxMime,
    ],
    [
      'macro',
      [...wordEntries, { name: 'word/vbaProject.bin', content: 'never execute' }],
      docxMime,
    ],
    [
      'embedded object',
      [...wordEntries, { name: 'word/embeddings/oleObject1.bin', content: 'never execute' }],
      docxMime,
    ],
    [
      'XML entity',
      [
        ...wordEntries,
        {
          name: 'word/unsafe.xml',
          content: '<!DOCTYPE x [<!ENTITY p SYSTEM "http://127.0.0.1/">]><x>&p;</x>',
        },
      ],
      docxMime,
    ],
    [
      'deep XML',
      [...wordEntries, { name: 'word/deep.xml', content: '<x>'.repeat(65) + '</x>'.repeat(65) }],
      docxMime,
    ],
    [
      'compression bomb',
      [...wordEntries, { name: 'word/bomb.xml', content: 'A'.repeat(100000) }],
      docxMime,
    ],
    [
      'lying size',
      [...wordEntries, { name: 'word/lie.xml', content: 'A'.repeat(100000), advertisedSize: 1 }],
      docxMime,
    ],
    [
      'expanded size',
      [...wordEntries, { name: 'word/big.xml', content: 'x', advertisedSize: 33 * 1024 * 1024 }],
      docxMime,
    ],
  ] as const)('rejects %s', (_label, entries, mime) => {
    expect(() => validateContainer(zip([...entries]), mime)).toThrow();
  });
  it('rejects too many entries and sparse worksheet allocation bombs', () => {
    expect(() =>
      validateContainer(
        zip(
          Array.from({ length: 1001 }, (_, index) => ({ name: `${index}.xml`, content: 'test' })),
        ),
        docxMime,
      ),
    ).toThrow();
    const entries = [
      { name: '[Content_Types].xml', content: '<Types />' },
      { name: 'xl/workbook.xml', content: '<workbook />' },
      {
        name: 'xl/worksheets/sheet1.xml',
        content:
          '<worksheet><dimension ref="A1:XFD1048576"/><c r="XFD1048576"><v>1</v></c></worksheet>',
      },
    ];
    expect(() => validateContainer(zip(entries), materialTypes.xlsx)).toThrow();
  });
  it('rejects truncated archives and invalid CFB directories', () => {
    const bytes = zip(wordEntries);
    expect(() => validateContainer(bytes.subarray(0, -1), docxMime)).toThrow();
    expect(() =>
      validateContainer(Buffer.from('d0cf11e0a1b11ae1', 'hex'), materialTypes.doc),
    ).toThrow();
  });
});

describe('material filename and byte boundaries', () => {
  it.each(['payload.exe', '../test.txt', 'a\\test.txt', 'bad\0.txt', 'a'.repeat(201) + '.txt'])(
    'rejects %s',
    (name) => {
      expect(() => materialMime(name, Buffer.from('test'))).toThrow(MaterialParseError);
    },
  );
  it('rejects empty, too large, binary UTF-8 and fake format bytes', () => {
    for (const [name, bytes] of [
      ['empty.txt', Buffer.alloc(0)],
      ['large.txt', Buffer.alloc(10 * 1024 * 1024 + 1)],
      ['bad.txt', Buffer.from([0xff])],
      ['bad.csv', Buffer.from('a\0b')],
      ['fake.pdf', Buffer.from('not pdf')],
      ['fake.doc', Buffer.from('not doc')],
      ['fake.docx', Buffer.from('not zip')],
    ] as const)
      expect(() => materialMime(name, bytes)).toThrow(MaterialParseError);
  });
});
