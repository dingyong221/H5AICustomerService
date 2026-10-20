import { extractBytesSync } from '@kreuzberg/node';
import { validateContainer } from './material-container-safety.mjs';
const chunks = [];
let length = 0;
for await (const chunk of process.stdin) {
  length += chunk.length;
  if (length > 10 * 1024 * 1024) process.exit(2);
  chunks.push(chunk);
}
try {
  const bytes = Buffer.concat(chunks);
  validateContainer(bytes, process.argv[2]);
  const result = extractBytesSync(bytes, process.argv[2], {
    useCache: false,
    enableQualityProcessing: false,
    ocr: null,
    forceOcr: false,
    outputFormat: 'plain',
    pdfOptions: { extractImages: false },
    securityLimits: {
      // N-API's JsSecurityLimits uses camelCase (not the Rust snake_case).
      // OOXML is separately bounded before extraction; not every Office
      // extractor consumes the library's general archive limits.
      maxArchiveSize: 32 * 1024 * 1024,
      maxCompressionRatio: 100,
      maxFilesInArchive: 1000,
      maxNestingDepth: 2,
      maxContentSize: 256000,
      maxXmlDepth: 64,
      maxTableCells: 20000,
      maxIterations: 100000,
      maxEntityLength: 4096,
    },
  });
  const text = result.content
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim();
  if (!text || text.length > 24000) process.exit(3);
  process.stdout.write(JSON.stringify({ text }));
} catch {
  process.exit(4);
}
