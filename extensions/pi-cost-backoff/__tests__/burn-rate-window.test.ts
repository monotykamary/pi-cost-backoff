import { describe, it, expect } from 'vitest';
import { computeBurnRateUsdPerMin, pruneWindow, type CostSample } from '../index.js';

describe('computeBurnRateUsdPerMin', () => {
  it('returns null for an empty window', () => {
    expect(computeBurnRateUsdPerMin([], 10_000, 60_000)).toBeNull();
  });

  it('returns null when all samples fall outside the window', () => {
    const now = 100_000;
    const window: CostSample[] = [
      { costUsd: 1, ts: 1000 }, // 99s ago, outside 60s window
    ];
    expect(computeBurnRateUsdPerMin(window, now, 60_000)).toBeNull();
  });

  it('computes $/min for a single recent sample clamped to 1s elapsed', () => {
    // 1 sample costing $0.10, 1ms ago → elapsed clamped to 1s → $0.10/s * 60 = $6.00/min
    const now = 100_001;
    const window: CostSample[] = [{ costUsd: 0.1, ts: 100_000 }];
    expect(computeBurnRateUsdPerMin(window, now, 60_000)).toBeCloseTo(6.0, 5);
  });

  it('sums multiple in-window samples', () => {
    // Two samples: $0.05 each at t=5s and t=10s, now=65s (oldest in-window is t=5s)
    // elapsed = 65-5 = 60s; total = $0.10; rate = 0.10/60 * 60 = $0.10/min
    const now = 65_000;
    const window: CostSample[] = [
      { costUsd: 0.05, ts: 5_000 },
      { costUsd: 0.05, ts: 10_000 },
    ];
    expect(computeBurnRateUsdPerMin(window, now, 60_000)).toBeCloseTo(0.1, 5);
  });

  it('ignores samples outside the window', () => {
    const now = 65_000;
    const window: CostSample[] = [
      { costUsd: 99, ts: 1_000 }, // outside 60s window (64s ago)
      { costUsd: 0.1, ts: 60_000 }, // inside (5s ago)
    ];
    // elapsed = 65-60 = 5s; total = 0.1; rate = 0.1/5 * 60 = $1.20/min
    expect(computeBurnRateUsdPerMin(window, now, 60_000)).toBeCloseTo(1.2, 5);
  });

  it('uses the oldest in-window sample as the span origin', () => {
    // Samples at t=0, 30, 60, now=60. Oldest in-window is t=0 (exactly at cutoff).
    // elapsed = 60s; total = 0.30; rate = 0.30/60 * 60 = $0.30/min
    const now = 60_000;
    const window: CostSample[] = [
      { costUsd: 0.1, ts: 0 },
      { costUsd: 0.1, ts: 30_000 },
      { costUsd: 0.1, ts: 60_000 },
    ];
    expect(computeBurnRateUsdPerMin(window, now, 60_000)).toBeCloseTo(0.3, 5);
  });

  it('returns a finite, non-negative number when computable', () => {
    const window: CostSample[] = [{ costUsd: 0, ts: Date.now() }];
    const rate = computeBurnRateUsdPerMin(window, Date.now(), 60_000);
    expect(rate).not.toBeNull();
    expect(Number.isFinite(rate)).toBe(true);
    expect(rate! >= 0).toBe(true);
  });
});

describe('pruneWindow', () => {
  it('removes samples older than the window, in place', () => {
    const now = 100_000;
    const window: CostSample[] = [
      { costUsd: 1, ts: 1000 }, // outside
      { costUsd: 2, ts: 50_000 }, // inside
      { costUsd: 3, ts: 80_000 }, // inside
      { costUsd: 4, ts: 99_000 }, // inside
    ];
    const result = pruneWindow(window, now, 60_000);
    expect(result).toBe(window); // same reference, mutated in place
    expect(result).toEqual([
      { costUsd: 2, ts: 50_000 },
      { costUsd: 3, ts: 80_000 },
      { costUsd: 4, ts: 99_000 },
    ]);
  });

  it('preserves order of remaining samples', () => {
    const now = 1000;
    const window: CostSample[] = [
      { costUsd: 'a' as any, ts: 500 },
      { costUsd: 'b' as any, ts: 600 },
      { costUsd: 'c' as any, ts: 700 },
    ];
    pruneWindow(window, now, 1000); // all inside
    expect(window.map((s) => s.costUsd)).toEqual(['a', 'b', 'c']);
  });

  it('handles empty window', () => {
    const window: CostSample[] = [];
    pruneWindow(window, 1000, 1000);
    expect(window).toEqual([]);
  });

  it('clears all when everything is stale', () => {
    const window: CostSample[] = [
      { costUsd: 1, ts: 0 },
      { costUsd: 2, ts: 100 },
    ];
    pruneWindow(window, 10_000, 1000);
    expect(window).toEqual([]);
  });
});
