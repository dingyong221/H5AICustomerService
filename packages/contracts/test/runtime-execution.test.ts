import { it, expect } from 'vitest';
import { runtimeControlRequestSchema, executionStateSchema } from '../src/runtime-execution.js';
it('runtime command has exact bounded scope, CAS string revision, affirmative confirmation and request identity', () => {
  const input = {
    scope: { kind: 'job', jobId: 'a'.repeat(32) },
    action: 'pause',
    expectedRevision: '0',
    requestId: 'runtime_' + 'b'.repeat(32),
    reason: '合成暂停原因',
    confirmed: true,
  };
  expect(runtimeControlRequestSchema.safeParse(input).success).toBe(true);
  for (const change of [
    { scope: { kind: 'job', jobId: 'a'.repeat(32), merchantId: 'b'.repeat(32) } },
    { expectedRevision: 0 },
    { expectedRevision: 'invalid' },
    { expectedRevision: '' },
    { expectedRevision: '-1' },
    { expectedRevision: '18446744073709551616' },
    { confirmed: false },
    { operatorId: 'forged' },
    { requestId: 'any' },
  ])
    expect(runtimeControlRequestSchema.safeParse({ ...input, ...change }).success).toBe(false);
  expect(executionStateSchema.safeParse('manually_stopped')).toMatchObject({ success: false });
});
