import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import {
  reviewedHistoricalFixture as fixture,
  scanHistoricalCredentials,
} from './historical-credential-fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const gate = readFileSync(join(root, 'scripts/quality/release-gate.mjs'), 'utf8');
const patternsSource = gate.slice(
  gate.indexOf('const credentialPatterns ='),
  gate.indexOf('const assertNoTrackedSecrets ='),
);
assert(patternsSource.startsWith('const credentialPatterns ='));
const patterns = runInNewContext(`${patternsSource}\ncredentialPatterns();`);
assert.equal(patterns.length, 5);
const original = execFileSync('git', ['cat-file', 'blob', fixture.originalBlob], { cwd: root });
const corrected = readFileSync(join(root, fixture.path));
const originalLines = original.toString('utf8').split(/\r?\n/u);
const fixtureLine = originalLines.find((line) => patterns[0].expression.test(line));
const fixtureLineNumber = originalLines.indexOf(fixtureLine) + 1;
const readProof = (blob) => {
  if (blob === fixture.originalBlob) return original;
  if (blob === fixture.correctedBlob) return corrected;
  throw new Error('Unreviewed object');
};
function temporary(t) {
  const folder = mkdtempSync(join(tmpdir(), 'h5cs-history-fixtures-'));
  t.after(() => {
    const target = resolve(folder),
      prefix = resolve(tmpdir(), 'h5cs-history-fixtures-');
    assert(target.startsWith(prefix) && target !== resolve(tmpdir()));
    rmSync(target, { recursive: true, force: true });
  });
  const hooks = join(folder, 'empty-hooks');
  mkdirSync(hooks);
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'core.autocrlf=false',
        '-c',
        'core.safecrlf=false',
        '-c',
        `core.hooksPath=${hooks}`,
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.name=Synthetic Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...args,
      ],
      { cwd: folder, encoding: 'utf8' },
    ).trim();
  git('init', '--quiet');
  const write = (bytes, path = fixture.path) => {
    const file = join(folder, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  };
  const commit = () => {
    git('add', '--all');
    git('commit', '--quiet', '-m', 'Synthetic fixture scenario');
    return git('rev-parse', 'HEAD');
  };
  const history = () =>
    git(
      'log',
      '--all',
      '--no-ext-diff',
      '--no-renames',
      '--full-index',
      '--pretty=format:commit:%H',
      '-p',
    );
  return { folder, git, write, commit, history };
}
function added(t) {
  const repo = temporary(t);
  repo.write(original);
  repo.commit();
  assert.equal(repo.git('rev-parse', `HEAD:${fixture.path}`), fixture.originalBlob);
  return repo;
}
const scanned = (history, reader = readProof) =>
  scanHistoricalCredentials(history, patterns, reader);
const failCount = (result, count) => assert.equal(result.findings.length, count);

test('actual Git addition proves exactly one fixed synthetic line', (t) => {
  const repo = added(t);
  const result = scanned(repo.history(), (blob) =>
    execFileSync('git', ['cat-file', 'blob', blob], { cwd: repo.folder }),
  );
  assert.equal(result.verifiedFixtures, 1);
  failCount(result, 0);
});
test('actual Git correction deletion is checked as well as original addition', (t) => {
  const repo = added(t);
  repo.write(corrected);
  repo.commit();
  assert.equal(repo.git('rev-parse', `HEAD:${fixture.path}`), fixture.correctedBlob);
  const result = scanned(repo.history());
  assert.equal(result.verifiedFixtures, 2);
  failCount(result, 0);
});
test('actual Git unknown new blob cannot borrow context approval from the old blob', (t) => {
  const repo = added(t);
  const lines = [...originalLines];
  lines[fixtureLineNumber + 1] += ' // unreviewed adjacent edit';
  repo.write(lines.join('\n'));
  const commit = repo.commit();
  const result = scanned(repo.history());
  assert.equal(result.verifiedFixtures, 1);
  assert(result.findings.includes(`${commit} private key block`));
});
test('same exact Git blob under another path is never exempted', (t) => {
  const repo = temporary(t);
  repo.write(original, 'tests/foreign-fixture.mjs');
  repo.commit();
  const result = scanned(repo.history());
  assert.equal(result.verifiedFixtures, 0);
  failCount(result, 1);
});
test('a modified same-shape fixture has no approved blob or line proof', (t) => {
  const repo = temporary(t);
  repo.write(original.toString('utf8').replace(fixtureLine, `${fixtureLine} changed`));
  repo.commit();
  const result = scanned(repo.history());
  assert.equal(result.verifiedFixtures, 0);
  failCount(result, 1);
});
test('wrong blob IDs, absent proof and wrong proof bytes all fail closed', (t) => {
  const history = added(t).history();
  for (const changed of [
    history.replace(fixture.originalBlob, '1'.repeat(40)),
    history.replace(fixture.originalBlob, fixture.originalBlob.slice(0, 7)),
    history.replace(`a/${fixture.path}`, `a/other/${fixture.path}`),
  ]) {
    const result = scanned(changed);
    assert.equal(result.verifiedFixtures, 0);
    failCount(result, 1);
  }
  for (const reader of [
    undefined,
    () => {
      throw new Error('Missing object');
    },
    () => Buffer.from('wrong proof'),
  ]) {
    const result = scanHistoricalCredentials(history, patterns, reader);
    assert.equal(result.verifiedFixtures, 0);
    failCount(result, 1);
  }
});
test('exact blob metadata cannot approve a different line, position or truncated hunk', (t) => {
  const history = added(t).history();
  for (const changed of [
    history.replace(fixtureLine, `${fixtureLine} `),
    history.replace(/(@@ -0,0 \+)1,/u, '$12,'),
    history.split('\n').slice(0, 100).join('\n'),
  ]) {
    const result = scanned(changed);
    assert.equal(result.verifiedFixtures, 0);
    failCount(result, 1);
  }
});
test('duplicate line at the same approved Git position is not a second exemption', (t) => {
  const history = added(t).history();
  const repeated = `${history}\n@@ -0,0 +${fixtureLineNumber} @@\n+${fixtureLine}`;
  const result = scanned(repeated);
  assert.equal(result.verifiedFixtures, 1);
  failCount(result, 1);
});
test('context requires exact line position and proof on both sides', () => {
  const history = [
    `commit:${'a'.repeat(40)}`,
    `diff --git a/${fixture.path} b/${fixture.path}`,
    `index ${fixture.originalBlob}..${fixture.originalBlob} 100644`,
    `--- a/${fixture.path}`,
    `+++ b/${fixture.path}`,
    `@@ -${fixtureLineNumber} +${fixtureLineNumber} @@`,
    ` ${fixtureLine}`,
  ].join('\n');
  const result = scanned(history);
  assert.equal(result.verifiedFixtures, 1);
  failCount(result, 0);
  const unknownSide = history.replace(`..${fixture.originalBlob}`, `..${'2'.repeat(40)}`);
  assert.equal(scanned(unknownSide).verifiedFixtures, 0);
  failCount(scanned(unknownSide), 1);
  const wrongPosition = history.replace(`+${fixtureLineNumber} @@`, `+${fixtureLineNumber + 1} @@`);
  assert.equal(scanned(wrongPosition).verifiedFixtures, 0);
  failCount(scanned(wrongPosition), 1);
});
test('extra pattern on same line and separate line are still findings', (t) => {
  const history = added(t).history();
  const token = ['gh', 'p_', 'q'.repeat(24)].join('');
  const sameLine = scanned(history.replace(fixtureLine, `${fixtureLine} ${token}`));
  assert.equal(sameLine.verifiedFixtures, 0);
  failCount(sameLine, 2);
  const separate = scanned(`${history}\n+${token}`);
  assert.equal(separate.verifiedFixtures, 0); // Extra row also invalidates that hunk.
  failCount(separate, 2);
});
test('all original patterns on metadata/non-hunk lines remain detectable', () => {
  const shapes = [
    fixtureLine,
    ['AK', 'IA', 'A'.repeat(16)].join(''),
    ['AK', 'ID', 'q'.repeat(20)].join(''),
    ['gh', 'p_', 'q'.repeat(24)].join(''),
    ['s', 'k-', 'q'.repeat(24)].join(''),
  ];
  const result = scanned(`commit:${'b'.repeat(40)}\n${shapes.join('\n')}`);
  assert.equal(result.verifiedFixtures, 0);
  assert.equal(result.findings.length, patterns.length);
});
test('known original proof does not approve another matching row or pattern label', (t) => {
  const history = added(t).history();
  const expanded = [
    ...patterns,
    { label: 'additional shape', expression: new RegExp('fixt' + 'ure') },
  ];
  const result = scanHistoricalCredentials(history, expanded, readProof);
  assert.equal(result.verifiedFixtures, 0);
  assert(result.findings.some((entry) => entry.endsWith(' additional shape')));
  assert(result.findings.some((entry) => entry.endsWith(' private key block')));
});
test('a missing or modified corrected blob does not approve a removal', (t) => {
  const repo = added(t);
  repo.write(corrected);
  repo.commit();
  const result = scanned(repo.history(), (blob) => {
    if (blob === fixture.correctedBlob) throw new Error('Missing corrected proof');
    return readProof(blob);
  });
  assert.equal(result.verifiedFixtures, 1);
  failCount(result, 1);
});
test('the unchanged current workspace scanner still rejects the reviewed historical literal', (t) => {
  const repo = added(t);
  const trackedSource = gate.slice(
    gate.indexOf('const assertNoTrackedSecrets ='),
    gate.indexOf('const assertNoHistoricalSecrets ='),
  );
  assert(trackedSource.length > 1000);
  const scanCurrent = runInNewContext(`${trackedSource}\nassertNoTrackedSecrets;`, {
    workspaceFiles: () => [fixture.path],
    repositoryRoot: repo.folder,
    statSync,
    readFileSync,
    resolve,
    credentialPatterns: () => patterns,
    fail: (message) => {
      throw new Error(message);
    },
  });
  assert.throws(
    scanCurrent,
    new RegExp(`${fixture.path}:${fixtureLineNumber} private key block`, 'u'),
  );
});
