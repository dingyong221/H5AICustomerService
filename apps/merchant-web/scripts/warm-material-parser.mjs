// A TXT probe cannot verify PDFium's native dependencies or noexec temp paths.
if (!['/opt/deployed-app/parser-runtime', '/app/parser-runtime'].includes(process.env.TMPDIR)) {
  throw new Error('Expected the fixed private parser runtime directory');
}
const marker = 'H5CS parser native runtime verified';
const stream = `BT /F1 18 Tf 40 100 Td (${marker}) Tj ET`;
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
];
let pdf = '%PDF-1.4\n';
const offsets = [0];
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets
  .slice(1)
  .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
  .join('');
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const { extractBytesSync } = await import('@kreuzberg/node');
const result = extractBytesSync(Buffer.from(pdf), 'application/pdf', {
  useCache: false,
  enableQualityProcessing: false,
  ocr: null,
  forceOcr: false,
  pdfOptions: { extractImages: false },
});
if (!result.content.includes(marker)) throw new Error('Packaged PDF extraction failed');
process.stdout.write('Packaged PDF parser extraction passed.\n');
