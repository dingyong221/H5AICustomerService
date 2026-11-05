import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { usageBatchSchema, growthEnabled, usageDigest } from '../src/growth-usage.js';
const event = () => ({
  id: randomUUID(),
  instance: randomUUID(),
  event: 'control_click',
  page: 'registration',
  control: 'register.submit',
  activeMs: 0,
  at: new Date().toISOString(),
});
describe('first party usage boundaries', () => {
  it('accepts only registered fields and controls', () => {
    expect(usageBatchSchema.safeParse({ events: [event()] }).success).toBe(true);
    for (const field of ['phone', 'password', 'content', 'merchantId', 'actor'])
      expect(
        usageBatchSchema.safeParse({ events: [{ ...event(), [field]: 'not-collected' }] }).success,
      ).toBe(false);
    expect(
      usageBatchSchema.safeParse({ events: [{ ...event(), control: 'phone_13800000000' }] })
        .success,
    ).toBe(false);
  });
  it('bounds duration and batching', () => {
    expect(usageBatchSchema.safeParse({ events: Array.from({ length: 21 }, event) }).success).toBe(
      false,
    );
    expect(usageBatchSchema.safeParse({ events: [{ ...event(), activeMs: 15001 }] }).success).toBe(
      false,
    );
  });
  it('is explicitly disabled until migration and configuration are ready', () => {
    expect(growthEnabled({})).toBe(false);
    expect(growthEnabled({ H5CS_GROWTH_USAGE_ENABLED: 'true' })).toBe(true);
  });
  it('keeps browser and authenticated identities in different namespaces', () => {
    expect(usageDigest('consumer:x').equals(usageDigest('merchant:x'))).toBe(false);
  });
});
