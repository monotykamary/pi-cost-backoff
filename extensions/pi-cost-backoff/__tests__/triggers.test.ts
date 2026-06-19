import { describe, it, expect } from 'vitest';
import { evaluateTriggers, type BackoffConfig, type CostSample } from '../index.js';

function configWith(overrides: Partial<BackoffConfig>): BackoffConfig {
  return {
    capUsdPerM: null,
    capUsdPerMin: null,
    baseMs: 1000,
    maxMs: 30_000,
    windowMs: 60_000,
    decayMs: 30_000,
    jitterRatio: 0.2,
    disabled: false,
    ...overrides,
  };
}

describe('evaluateTriggers', () => {
  it('returns null when no caps are configured', () => {
    const trip = evaluateTriggers({ lastRateUsdPerM: 100, costWindow: [] }, configWith({}), 10_000);
    expect(trip).toBeNull();
  });

  it('returns null when caps are configured but not exceeded', () => {
    const trip = evaluateTriggers(
      { lastRateUsdPerM: 4.0, costWindow: [] },
      configWith({ capUsdPerM: 5.0, capUsdPerMin: 1.0 }),
      10_000
    );
    expect(trip).toBeNull();
  });

  describe('spike trigger ($/Mtok)', () => {
    it('trips when lastRateUsdPerM exceeds cap', () => {
      const trip = evaluateTriggers(
        { lastRateUsdPerM: 6.0, costWindow: [] },
        configWith({ capUsdPerM: 5.0 }),
        10_000
      );
      expect(trip).not.toBeNull();
      expect(trip!.kind).toBe('spike');
      expect(trip!.value).toBe(6.0);
      expect(trip!.threshold).toBe(5.0);
      expect(trip!.reason).toContain('6.00');
      expect(trip!.reason).toContain('5.00');
    });

    it('does not trip when lastRateUsdPerM is null (no signal yet)', () => {
      const trip = evaluateTriggers(
        { lastRateUsdPerM: null, costWindow: [] },
        configWith({ capUsdPerM: 5.0 }),
        10_000
      );
      expect(trip).toBeNull();
    });

    it('does not trip when rate equals cap (strict >)', () => {
      const trip = evaluateTriggers(
        { lastRateUsdPerM: 5.0, costWindow: [] },
        configWith({ capUsdPerM: 5.0 }),
        10_000
      );
      expect(trip).toBeNull();
    });

    it('takes precedence over burn when both would trip', () => {
      const now = 100_000;
      const window: CostSample[] = [
        { costUsd: 10, ts: 99_999 }, // huge recent spend → burn trips
      ];
      const trip = evaluateTriggers(
        { lastRateUsdPerM: 10.0, costWindow: window },
        configWith({ capUsdPerM: 5.0, capUsdPerMin: 1.0 }),
        now
      );
      expect(trip!.kind).toBe('spike'); // not 'burn'
    });
  });

  describe('burn trigger ($/min)', () => {
    it('trips when rolling $/min exceeds cap', () => {
      // $0.10 spent 1ms ago → elapsed clamped to 1s → $6/min; cap = $1/min
      const now = 100_001;
      const window: CostSample[] = [{ costUsd: 0.1, ts: 100_000 }];
      const trip = evaluateTriggers(
        { lastRateUsdPerM: null, costWindow: window },
        configWith({ capUsdPerMin: 1.0 }),
        now
      );
      expect(trip).not.toBeNull();
      expect(trip!.kind).toBe('burn');
      expect(trip!.threshold).toBe(1.0);
      expect(trip!.reason).toContain('$/min');
    });

    it('does not trip when $/min is below cap', () => {
      // $0.10 over 60s → $0.10/min; cap = $1/min
      const now = 65_000;
      const window: CostSample[] = [{ costUsd: 0.1, ts: 5_000 }];
      const trip = evaluateTriggers(
        { lastRateUsdPerM: null, costWindow: window },
        configWith({ capUsdPerMin: 1.0 }),
        now
      );
      expect(trip).toBeNull();
    });

    it('does not trip when window is empty', () => {
      const trip = evaluateTriggers(
        { lastRateUsdPerM: null, costWindow: [] },
        configWith({ capUsdPerMin: 1.0 }),
        10_000
      );
      expect(trip).toBeNull();
    });
  });
});
