import { describe, it, expect } from 'vitest';
import { computeBackoffDelay, applyJitter, applyDecay } from '../index.js';

describe('computeBackoffDelay', () => {
  it('returns 0 for level 0 (no backoff)', () => {
    expect(computeBackoffDelay(0, 1000, 30_000)).toBe(0);
  });

  it('returns 0 for negative levels', () => {
    expect(computeBackoffDelay(-3, 1000, 30_000)).toBe(0);
  });

  it('doubles per level: 1s, 2s, 4s, 8s, 16s (within max)', () => {
    expect(computeBackoffDelay(1, 1000, 30_000)).toBe(2000);
    expect(computeBackoffDelay(2, 1000, 30_000)).toBe(4000);
    expect(computeBackoffDelay(3, 1000, 30_000)).toBe(8000);
    expect(computeBackoffDelay(4, 1000, 30_000)).toBe(16_000);
  });

  it('clamps to maxMs (base=1s, max=30s caps level 5+ at 30s)', () => {
    expect(computeBackoffDelay(5, 1000, 30_000)).toBe(30_000); // 32s clamped
    expect(computeBackoffDelay(6, 1000, 30_000)).toBe(30_000);
    expect(computeBackoffDelay(8, 1000, 30_000)).toBe(30_000);
  });

  it('respects the configured base and max independently', () => {
    // base 500ms, max 10s: level 1 = 1s, level 2 = 2s, level 4 = 8s, level 5 = 16s → clamp to 10s
    expect(computeBackoffDelay(1, 500, 10_000)).toBe(1000);
    expect(computeBackoffDelay(4, 500, 10_000)).toBe(8000);
    expect(computeBackoffDelay(5, 500, 10_000)).toBe(10_000); // 500*32=16000 clamped to max
  });

  it('clamps when base*2^level exceeds max even at low levels', () => {
    // base 4s, max 5s: level 1 = 8s → clamped to 5s
    expect(computeBackoffDelay(1, 4000, 5000)).toBe(5000);
  });
});

describe('applyJitter', () => {
  it('returns the delay unchanged when jitterRatio is 0', () => {
    expect(applyJitter(5000, 0)).toBe(5000);
  });

  it('returns 0 only when delayMs is 0', () => {
    expect(applyJitter(0, 0.2)).toBe(0);
  });

  it('applies deterministic offset via injected rng', () => {
    // rng()=0.5 → offset 0 → delay unchanged
    expect(applyJitter(1000, 0.2, () => 0.5)).toBe(1000);
    // rng()=0 → offset = -jitter = -200 → 800
    expect(applyJitter(1000, 0.2, () => 0)).toBe(800);
    // rng()=0.9999... → offset ≈ +jitter = +200 → 1200
    expect(applyJitter(1000, 0.2, () => 0.9999)).toBe(1200);
  });

  it('never returns negative (clamps at 0)', () => {
    // Tiny delay, max negative offset.
    expect(applyJitter(10, 1.0, () => 0)).toBe(0);
  });
});

describe('applyDecay', () => {
  it('returns level 0 immediately when already at 0, stamping lastCleanMs', () => {
    const { level, lastCleanMs } = applyDecay(0, null, 1000, 30_000);
    expect(level).toBe(0);
    expect(lastCleanMs).toBe(1000);
  });

  it('starts the clean timer (no decay) when lastCleanMs is null', () => {
    const { level, lastCleanMs } = applyDecay(3, null, 5000, 30_000);
    expect(level).toBe(3); // unchanged
    expect(lastCleanMs).toBe(5000); // timer started
  });

  it('does not decay when elapsed < decayMs', () => {
    const { level, lastCleanMs } = applyDecay(3, 1000, 5000, 30_000); // elapsed 4s < 30s
    expect(level).toBe(3);
    expect(lastCleanMs).toBe(1000); // unchanged — timer not reset
  });

  it('decays one level after a full decayMs of clean behavior', () => {
    const { level, lastCleanMs } = applyDecay(3, 1000, 31_000, 30_000); // elapsed 30s
    expect(level).toBe(2);
    expect(lastCleanMs).toBe(31_000); // 1000 + 1*30000
  });

  it('decays multiple levels when elapsed spans multiple intervals', () => {
    // elapsed 75s = 2.5 intervals → decay 2 levels, residual 15s preserved
    const { level, lastCleanMs } = applyDecay(3, 1000, 76_000, 30_000);
    expect(level).toBe(1);
    expect(lastCleanMs).toBe(61_000); // 1000 + 2*30000
  });

  it('clamps at level 0 (does not go negative)', () => {
    const { level } = applyDecay(1, 1000, 1_000_000, 30_000);
    expect(level).toBe(0);
  });
});
