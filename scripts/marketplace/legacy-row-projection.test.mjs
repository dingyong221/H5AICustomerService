import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyRowJson } from './legacy-row-projection.mjs';

const original = { id: 'synthetic-retained-job', state: 'completed', payload: '{"v":1}', attempt: 1 };
test('legacy job projection accepts only additive nullable result and retains original fields', () => {
  const migrated = { ...original, claim_generation: 0, model_outcome: 'none', model_attempt_id: null, result: null };
  assert.equal(legacyRowJson('job', original), legacyRowJson('job', migrated));
  for (const [field, value] of [['state','failed'], ['payload','{"v":2}'], ['attempt',2], ['id','another-job']])
    assert.notEqual(legacyRowJson('job', original), legacyRowJson('job', { ...migrated, [field]:value }));
});
test('non-null knowledge result cannot silently hide a changed legacy job', () => {
  for (const result of [{ summary: 'unexpected' }, '{}', '', 0, false])
    assert.throws(() => legacyRowJson('job', { ...original, result }), /Unexpected knowledge result/);
});
test('the compatibility projection never omits data from unrelated tables', () => {
  assert.notEqual(legacyRowJson('message', original), legacyRowJson('message', { ...original, result:null }));
});
