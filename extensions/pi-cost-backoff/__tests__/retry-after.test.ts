import { describe, it, expect } from 'vitest';
import { parseRetryAfterMs } from '../index.js';

describe('parseRetryAfterMs', () => {
  it('returns null for undefined header', () => {
    expect(parseRetryAfterMs(undefined)).toBeNull();
  });

  it('returns null for empty/whitespace header', () => {
    expect(parseRetryAfterMs('')).toBeNull();
    expect(parseRetryAfterMs('   ')).toBeNull();
  });

  it('parses integer delta-seconds → milliseconds', () => {
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs('120')).toBe(120_000);
  });

  it('parses decimal delta-seconds', () => {
    expect(parseRetryAfterMs('2.5')).toBe(2500);
  });

  it('parses a future HTTP-date → delta in ms', () => {
    // Fixed future date so the test is deterministic relative to "now".
    // Use a date 60s in the future computed at test time.
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).not.toBeNull();
    // Allow ±2s slop for test execution + Date.parse rounding.
    expect(ms).toBeGreaterThan(58_000);
    expect(ms).toBeLessThan(62_000);
  });

  it('returns 0 for a past HTTP-date', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterMs(past)).toBe(0);
  });

  it('returns null for unparseable header', () => {
    expect(parseRetryAfterMs('not-a-date-or-number')).toBeNull();
  });

  it('rejects negative delta-seconds', () => {
    // Negative numbers don't match the delta-seconds regex; Date.parse also fails → null.
    expect(parseRetryAfterMs('-5')).toBeNull();
  });

  it('rejects text with a unit suffix (not a plain number)', () => {
    // "5s" is not delta-seconds and not a parseable date → null.
    expect(parseRetryAfterMs('5s')).toBeNull();
  });
});
