import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readMetadata, validateAll, validateSkill } from './validate-workbuddy-skills.mjs';

test('all independent packages validate against their resources and live field contract', async () => {
  const result = await validateAll();
  assert.equal(result.skills.length, 4);
  assert.equal(result.clientImportVerified, false);
  assert.equal(result.marketplaceApproved, false);
  for (const skill of result.skills)
    assert.ok(skill.files.every((file) => /^[0-9a-f]{64}$/u.test(file.sha256)));
});

test('metadata rejects duplicates, unsupported tool configuration and multiline YAML', () => {
  for (const text of [
    '---\nname: one\nname: two\n---\n',
    '---\nallowed-tools: unsafe-tool\n---\n',
    '---\ndescription: >\n---\n',
  ])
    assert.throws(() => readMetadata(text));
  assert.equal(
    readMetadata('---\nname: example\ndisable-model-invocation: false\n---\n')[
      'disable-model-invocation'
    ],
    false,
  );
});

test('a package with a missing reference or secret-like file is rejected', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'h5cs-skill-validation-'));
  const folder = join(parent, 'test-skill');
  await mkdir(folder);
  const text =
    '---\nname: test-skill\ndescription: Example\ndescription_zh: 示例\ndescription_en: Example\nversion: 0.1.0\nauthor: test\ndisable-model-invocation: false\nuser-invocable: true\n---\n@references/missing.md\n';
  try {
    await writeFile(join(folder, 'SKILL.md'), text);
    await assert.rejects(validateSkill(folder), /Missing skill reference/u);
    await writeFile(join(folder, '.env'), 'test-data-not-a-secret');
    await assert.rejects(validateSkill(folder), /Unexpected file/u);
  } finally {
    // Only the directory just allocated by mkdtemp is removed; never a repository.
    assert.equal(parent.startsWith(join(tmpdir(), 'h5cs-skill-validation-')), true);
    await rm(parent, { recursive: true, force: true });
  }
});
