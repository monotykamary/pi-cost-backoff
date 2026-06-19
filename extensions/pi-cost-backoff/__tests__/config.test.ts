import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readConfig, type BackoffConfig } from '../index.js';

const ENV_VARS = [
  'COST_CAP_USD_PER_M',
  'COST_CAP_USD_PER_MIN',
  'COST_BACKOFF_BASE_MS',
  'COST_BACKOFF_MAX_MS',
  'COST_BACKOFF_WINDOW_MS',
  'COST_BACKOFF_DECAY_MS',
];

function getFlagStub(flags: Record<string, boolean | string>) {
  return (name: string) => flags[name];
}

describe('readConfig', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {};
    for (const k of ENV_VARS) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_VARS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
    vi.restoreAllMocks();
  });

  it('returns defaults and disabled caps when nothing is configured', () => {
    const c = readConfig(getFlagStub({}));
    expect(c.capUsdPerM).toBeNull();
    expect(c.capUsdPerMin).toBeNull();
    expect(c.baseMs).toBe(1000);
    expect(c.maxMs).toBe(30_000);
    expect(c.windowMs).toBe(60_000);
    expect(c.decayMs).toBe(30_000);
    expect(c.jitterRatio).toBe(0.2);
    expect(c.disabled).toBe(false);
  });

  it('reads string flags as numbers', () => {
    const c = readConfig(
      getFlagStub({
        'cost-cap-usd-per-m': '5.00',
        'cost-cap-usd-per-min': '0.50',
        'cost-backoff-base-ms': '2000',
        'cost-backoff-max-ms': '60000',
        'cost-backoff-window-ms': '120000',
        'cost-backoff-decay-ms': '15000',
      })
    );
    expect(c.capUsdPerM).toBe(5);
    expect(c.capUsdPerMin).toBe(0.5);
    expect(c.baseMs).toBe(2000);
    expect(c.maxMs).toBe(60_000);
    expect(c.windowMs).toBe(120_000);
    expect(c.decayMs).toBe(15_000);
  });

  it('falls back to env vars when flags are absent', () => {
    process.env.COST_CAP_USD_PER_M = '7.5';
    process.env.COST_BACKOFF_BASE_MS = '500';
    const c = readConfig(getFlagStub({}));
    expect(c.capUsdPerM).toBe(7.5);
    expect(c.baseMs).toBe(500);
  });

  it('flag value wins over env', () => {
    process.env.COST_CAP_USD_PER_M = '7.5';
    const c = readConfig(getFlagStub({ 'cost-cap-usd-per-m': '3.0' }));
    expect(c.capUsdPerM).toBe(3);
  });

  it('rejects non-numeric flag values (returns null → trigger disabled)', () => {
    const c = readConfig(getFlagStub({ 'cost-cap-usd-per-m': 'not-a-number' }));
    expect(c.capUsdPerM).toBeNull();
  });

  it('rejects negative values', () => {
    const c = readConfig(
      getFlagStub({ 'cost-cap-usd-per-m': '-1', 'cost-backoff-base-ms': '-100' })
    );
    expect(c.capUsdPerM).toBeNull();
    expect(c.baseMs).toBe(1000); // default
  });

  it('disabled flag (boolean true) sets disabled=true', () => {
    const c = readConfig(getFlagStub({ 'cost-backoff-disable': true }));
    expect(c.disabled).toBe(true);
  });

  it('enforces maxMs >= baseMs', () => {
    // base 2000, max 500 → max should be lifted to 2000
    const c = readConfig(
      getFlagStub({ 'cost-backoff-base-ms': '2000', 'cost-backoff-max-ms': '500' })
    );
    expect(c.baseMs).toBe(2000);
    expect(c.maxMs).toBe(2000);
  });
});
