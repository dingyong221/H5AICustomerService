import { createHash } from 'node:crypto';

// Reviewed non-secret line only. No commit, directory, blob-wide or generic
// credential-pattern exemption is granted. Keep payload text out of this table.
export const reviewedHistoricalFixture = Object.freeze({
  path: 'scripts/runtime/watchdog.test.mjs',
  originalBlob: '5f9058bf2e453181d7b254518c2fbfd26b3ee8c0',
  originalSha256: 'de74c1d6c0946160254bc7b389e2db0e1d4ce2f6a04a1c606dfd20824537e850',
  correctedBlob: '266af6a1e18db3c7f7010eaf36fa1b985b204ad6',
  correctedSha256: 'f8d0118a5ba139539aa12594af7d9efd45fe9e199e6178b59be33ed32723dc2a',
  lineSha256: '677d01db085e1fc5f53d14418537ce267e81e2caccb98d9f97177e8228ec9d15',
  reason:
    'WI-20261117-013: one synthetic invalid-token literal, no key body; AST and exact Git objects independently reviewable.',
});
const digest = (value) => createHash('sha256').update(value).digest('hex');
const zero = '0'.repeat(40);

export function scanHistoricalCredentials(history, patterns, readBlob) {
  const fixture = reviewedHistoricalFixture;
  const proofs = new Map();
  const proof = (blob) => {
    if (proofs.has(blob)) return proofs.get(blob);
    let result = null;
    try {
      const expected =
        blob === fixture.originalBlob
          ? fixture.originalSha256
          : blob === fixture.correctedBlob
            ? fixture.correctedSha256
            : null;
      if (!expected || typeof readBlob !== 'function') throw new Error('No reviewed proof');
      const bytes = Buffer.from(readBlob(blob));
      if (digest(bytes) !== expected) throw new Error('Blob proof differs');
      const lines = bytes.toString('utf8').split(/\r?\n/u);
      const hits = lines.flatMap((line, index) =>
        patterns.flatMap((pattern) =>
          pattern.expression.test(line)
            ? [{ index, label: pattern.label, lineHash: digest(line) }]
            : [],
        ),
      );
      if (blob === fixture.originalBlob) {
        if (
          hits.length !== 1 ||
          hits[0].label !== 'private key block' ||
          hits[0].lineHash !== fixture.lineSha256
        )
          throw new Error('Original blob is not the single reviewed synthetic finding');
      } else if (hits.length) throw new Error('Corrected blob contains a finding');
      result = { lines };
    } catch {
      // A failed/missing proof never approves a matching line.
    }
    proofs.set(blob, result);
    return result;
  };
  let commit = 'unknown',
    patch = null,
    hunk = null;
  const matches = [];
  const finishHunk = () => {
    if (hunk && (hunk.oldRemaining !== 0 || hunk.newRemaining !== 0)) hunk.valid = false;
    hunk = null;
  };
  for (const line of history.split(/\r?\n/u)) {
    let candidate = null;
    if (line.startsWith('commit:')) {
      finishHunk();
      commit = line.slice(7);
      patch = null;
    } else if (line.startsWith('diff --git ')) {
      finishHunk();
      patch = {
        valid: line === `diff --git a/${fixture.path} b/${fixture.path}`,
        oldBlob: null,
        newBlob: null,
        oldPath: null,
        newPath: null,
      };
    } else if (line.startsWith('index ') && patch && !hunk) {
      const parsed = line.match(/^index ([a-f0-9]{40})\.\.([a-f0-9]{40})(?: [0-7]{6})?$/u);
      if (!parsed || patch.oldBlob) patch.valid = false;
      else [patch.oldBlob, patch.newBlob] = parsed.slice(1);
    } else if (line.startsWith('--- ') && patch && !hunk) {
      if (patch.oldPath) patch.valid = false;
      patch.oldPath = line.slice(4);
    } else if (line.startsWith('+++ ') && patch && !hunk) {
      if (patch.newPath) patch.valid = false;
      patch.newPath = line.slice(4);
    } else if (line.startsWith('@@ ')) {
      finishHunk();
      const parsed = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u);
      if (parsed && patch)
        hunk = {
          oldLine: Number(parsed[1]),
          newLine: Number(parsed[3]),
          oldRemaining: Number(parsed[2] ?? 1),
          newRemaining: Number(parsed[4] ?? 1),
          valid: true,
        };
    } else if (hunk && /^[ +\-]/u.test(line)) {
      const sign = line[0];
      const consumesOld = sign !== '+',
        consumesNew = sign !== '-';
      if ((consumesOld && hunk.oldRemaining <= 0) || (consumesNew && hunk.newRemaining <= 0))
        hunk.valid = false;
      candidate = {
        patch,
        hunk,
        sign,
        text: line.slice(1),
        oldLine: hunk.oldLine,
        newLine: hunk.newLine,
      };
      if (consumesOld) {
        hunk.oldLine++;
        hunk.oldRemaining--;
      }
      if (consumesNew) {
        hunk.newLine++;
        hunk.newRemaining--;
      }
    } else if (hunk && line !== '\\ No newline at end of file') {
      finishHunk();
    }
    // Preserve detection on EVERY original history line, including metadata,
    // unsupported diff formats and hunk context. Parsing never skips detection.
    for (const pattern of patterns) {
      if (pattern.expression.test(line)) matches.push({ commit, label: pattern.label, candidate });
    }
  }
  finishHunk();
  const seen = new Set();
  let verifiedFixtures = 0;
  const findings = [];
  for (const match of matches) {
    const c = match.candidate,
      p = c?.patch;
    let approved = false;
    if (
      match.label === 'private key block' &&
      p?.valid &&
      c.hunk.valid &&
      digest(c.text) === fixture.lineSha256
    ) {
      const original = () => proof(fixture.originalBlob);
      const originalLine = (position) => original()?.lines[position - 1] === c.text;
      if (
        c.sign === '+' &&
        p.oldBlob === zero &&
        p.newBlob === fixture.originalBlob &&
        p.oldPath === '/dev/null' &&
        p.newPath === `b/${fixture.path}`
      )
        approved = originalLine(c.newLine);
      else if (
        c.sign === '-' &&
        p.oldBlob === fixture.originalBlob &&
        p.newBlob === fixture.correctedBlob &&
        p.oldPath === `a/${fixture.path}` &&
        p.newPath === `b/${fixture.path}`
      )
        approved = !!proof(fixture.correctedBlob) && originalLine(c.oldLine);
      else if (
        c.sign === ' ' &&
        p.oldBlob === fixture.originalBlob &&
        p.newBlob === fixture.originalBlob &&
        p.oldPath === `a/${fixture.path}` &&
        p.newPath === `b/${fixture.path}`
      )
        approved = originalLine(c.oldLine) && originalLine(c.newLine);
      const occurrence = `${match.commit}:${p.oldBlob}:${p.newBlob}:${c.sign}:${c.oldLine}:${c.newLine}`;
      if (seen.has(occurrence)) approved = false;
      if (approved) seen.add(occurrence);
    }
    if (approved) verifiedFixtures++;
    else findings.push(`${match.commit} ${match.label}`);
  }
  return { findings, verifiedFixtures };
}
