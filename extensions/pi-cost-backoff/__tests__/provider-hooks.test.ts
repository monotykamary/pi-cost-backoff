import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestFixture,
  activateExtension,
  setFlag,
  makeTpsTelemetry,
  makeAssistantMessageWithCost,
  fireTurnEnd,
} from './helpers';

/**
 * Integration coverage for the wired-up extension. Uses fake timers +
 * Math.random spy (→ 0.5, zero jitter offset) so backoff delays are
 * deterministic: base=1s → level 1 = 2s, level 2 = 4s, level 3 = 8s.
 */

const BASE_TIME = new Date('2026-01-01T00:00:00Z').getTime();

describe('pi-cost-backoff extension — provider hooks integration', () => {
  let fixture: ReturnType<typeof createTestFixture>;
  let randomSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    // Zero jitter: rng()=0.5 → offset 0 → delay == exponential floor exactly.
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    fixture = createTestFixture();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('captures rateUsdPerMTokens and cost.total from tps:telemetry', async () => {
    setFlag(fixture, 'cost-cap-usd-per-m', '5.0');
    await activateExtension(fixture);

    fixture.emitEvent(
      'tps:telemetry',
      makeTpsTelemetry({ rateUsdPerMTokens: 4.2, costTotal: 0.004 })
    );

    // The /cost-backoff command reflects captured state.
    await fixture.commands['cost-backoff'].handler('', fixture.mockCtx);
    const msg = fixture.notifySpy.mock.calls.at(-1)![0] as string;
    expect(msg).toContain('last $/M 4.20');
    expect(msg).toContain('window 1 samples');
  });

  it('backs off on the next request after a $/Mtok spike', async () => {
    setFlag(fixture, 'cost-cap-usd-per-m', '5.0');
    setFlag(fixture, 'cost-backoff-base-ms', '1000');
    setFlag(fixture, 'cost-backoff-max-ms', '30000');
    await activateExtension(fixture);

    // 6.0 $/Mtok > 5.0 cap → spike.
    fixture.emitEvent(
      'tps:telemetry',
      makeTpsTelemetry({ rateUsdPerMTokens: 6.0, costTotal: 0.006 })
    );

    const promise = fixture.fireBeforeProviderRequest();

    // Level 1 → delay = base * 2^1 = 2000ms (jitter zeroed).
    expect(fixture.setStatusSpy).toHaveBeenCalledWith(
      'pi-cost-backoff',
      expect.stringContaining('backoff 2.0s')
    );
    expect(fixture.setStatusSpy).toHaveBeenCalledWith(
      'pi-cost-backoff',
      expect.stringContaining('6.00')
    );
    expect(fixture.notifySpy).toHaveBeenCalledWith(
      expect.stringContaining('waiting 2.0s'),
      'warning'
    );

    await vi.advanceTimersByTimeAsync(2000);
    await promise;
  });

  it('does not back off or replace the payload when no signal has been seen yet', async () => {
    setFlag(fixture, 'cost-cap-usd-per-m', '5.0');
    await activateExtension(fixture);

    // Returning undefined preserves payload replacements from other provider middleware.
    const result = await fixture.fireBeforeProviderRequest();

    expect(result).toBeUndefined();
    expect(fixture.setStatusSpy).not.toHaveBeenCalled();
    expect(fixture.notifySpy).not.toHaveBeenCalled();
  });

  it('does not back off when the rate is below the cap', async () => {
    setFlag(fixture, 'cost-cap-usd-per-m', '5.0');
    await activateExtension(fixture);

    fixture.emitEvent(
      'tps:telemetry',
      makeTpsTelemetry({ rateUsdPerMTokens: 4.0, costTotal: 0.004 })
    );
    await fixture.fireBeforeProviderRequest();

    expect(fixture.notifySpy).not.toHaveBeenCalled();
  });

  it('escalates the delay across consecutive spike trips', async () => {
    setFlag(fixture, 'cost-cap-usd-per-m', '5.0');
    await activateExtension(fixture);

    fixture.emitEvent('tps:telemetry', makeTpsTelemetry({ rateUsdPerMTokens: 6.0 }));

    // Trip 1: level 1 → 2s
    let promise = fixture.fireBeforeProviderRequest();
    expect(fixture.setStatusSpy).toHaveBeenLastCalledWith(
      'pi-cost-backoff',
      expect.stringContaining('2.0s')
    );
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    // Trip 2 (rate still tripping): level 2 → 4s
    promise = fixture.fireBeforeProviderRequest();
    expect(fixture.setStatusSpy).toHaveBeenLastCalledWith(
      'pi-cost-backoff',
      expect.stringContaining('4.0s')
    );
    await vi.advanceTimersByTimeAsync(4000);
    await promise;

    // Trip 3: level 3 → 8s
    promise = fixture.fireBeforeProviderRequest();
    expect(fixture.setStatusSpy).toHaveBeenLastCalledWith(
      'pi-cost-backoff',
      expect.stringContaining('8.0s')
    );
    await vi.advanceTimersByTimeAsync(8000);
    await promise;
  });

  it('decays the level after sustained clean behavior and clears status', async () => {
    setFlag(fixture, 'cost-cap-usd-per-m', '5.0');
    setFlag(fixture, 'cost-backoff-decay-ms', '30000');
    await activateExtension(fixture);

    fixture.emitEvent('tps:telemetry', makeTpsTelemetry({ rateUsdPerMTokens: 6.0 }));

    // Trip to level 1 (2s).
    let promise = fixture.fireBeforeProviderRequest();
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    // Rate drops below cap → subsequent turns are clean.
    fixture.emitEvent('tps:telemetry', makeTpsTelemetry({ rateUsdPerMTokens: 3.0 }));
    fixture.notifySpy.mockClear();
    fixture.setStatusSpy.mockClear();

    // First clean request: starts the decay timer (level stays 1, no sleep).
    await fixture.fireBeforeProviderRequest();
    expect(fixture.notifySpy).not.toHaveBeenCalled();

    // Advance past one decay interval (30s) — the level should decay to 0.
    vi.setSystemTime(BASE_TIME + 35_000);
    // Another clean request triggers the decay → level 0 → status cleared.
    await fixture.fireBeforeProviderRequest();

    expect(fixture.setStatusSpy).toHaveBeenCalledWith('pi-cost-backoff', undefined);
  });

  it('a 429 sets a retry-after override honored (and escalated) by the next request', async () => {
    await activateExtension(fixture);

    // 429 with retry-after: 2s. Stashed silently (no notify yet).
    await fixture.fireAfterProviderResponse(429, { 'retry-after': '2' });
    expect(fixture.notifySpy).not.toHaveBeenCalled();

    // Next request consumes the override: level 0→1, delay = max(2000, 1*2^1=2000) = 2000.
    const promise = fixture.fireBeforeProviderRequest();
    expect(fixture.setStatusSpy).toHaveBeenLastCalledWith(
      'pi-cost-backoff',
      expect.stringContaining('2.0s')
    );
    expect(fixture.setStatusSpy).toHaveBeenLastCalledWith(
      'pi-cost-backoff',
      expect.stringContaining('429')
    );
    expect(fixture.notifySpy).toHaveBeenCalledWith(expect.stringContaining('429'), 'warning');
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
  });

  it('uses the fallback delay when a 429 arrives without retry-after', async () => {
    await activateExtension(fixture);

    await fixture.fireAfterProviderResponse(429, {});
    // override = RETRY_AFTER_FALLBACK_MS (5s). delay = max(5000, 2000) = 5000.
    const promise = fixture.fireBeforeProviderRequest();
    expect(fixture.setStatusSpy).toHaveBeenLastCalledWith(
      'pi-cost-backoff',
      expect.stringContaining('5.0s')
    );
    await vi.advanceTimersByTimeAsync(5000);
    await promise;
  });

  it('ignores non-429 responses', async () => {
    await activateExtension(fixture);

    await fixture.fireAfterProviderResponse(200, {});
    // No override set → next request is clean (no sleep).
    await fixture.fireBeforeProviderRequest();
    expect(fixture.notifySpy).not.toHaveBeenCalled();
  });

  it('captures cost from turn_end when pi-tps is absent → burn trip fires', async () => {
    setFlag(fixture, 'cost-cap-usd-per-min', '1.0');
    await activateExtension(fixture);

    // No tps:telemetry emitted → fallback path active.
    await fireTurnEnd(fixture, makeAssistantMessageWithCost({ costTotal: 0.1 }));

    // $0.10 just now → elapsed clamped to 1s → $6/min > $1/min cap → burn trip.
    const promise = fixture.fireBeforeProviderRequest();
    expect(fixture.notifySpy).toHaveBeenCalledWith(expect.stringContaining('$/min'), 'warning');
    // Level 1 → 2s.
    await vi.advanceTimersByTimeAsync(2000);
    await promise;
  });

  it('disables the turn_end fallback once tps:telemetry is seen (no double-count)', async () => {
    setFlag(fixture, 'cost-cap-usd-per-min', '100.0'); // high cap so it won't trip on its own
    await activateExtension(fixture);

    // A tps:telemetry event arrives → fallback permanently disabled.
    fixture.emitEvent(
      'tps:telemetry',
      makeTpsTelemetry({ rateUsdPerMTokens: 4.0, costTotal: 0.004 })
    );

    // Now a turn_end with cost should NOT push another sample.
    await fireTurnEnd(fixture, makeAssistantMessageWithCost({ costTotal: 0.1 }));

    await fixture.commands['cost-backoff'].handler('', fixture.mockCtx);
    const msg = fixture.notifySpy.mock.calls.at(-1)![0] as string;
    // Only the tps:telemetry sample (1), not the turn_end sample (would be 2).
    expect(msg).toContain('window 1 samples');
  });

  it('disabled flag makes every trigger a no-op', async () => {
    setFlag(fixture, 'cost-cap-usd-per-m', '5.0');
    setFlag(fixture, 'cost-backoff-disable', true);
    await activateExtension(fixture);

    fixture.emitEvent('tps:telemetry', makeTpsTelemetry({ rateUsdPerMTokens: 99.0 }));
    await fixture.fireBeforeProviderRequest();

    expect(fixture.notifySpy).not.toHaveBeenCalled();
    expect(fixture.setStatusSpy).not.toHaveBeenCalled();
  });

  it('disabled flag suppresses reactive 429 handling', async () => {
    setFlag(fixture, 'cost-backoff-disable', true);
    await activateExtension(fixture);

    await fixture.fireAfterProviderResponse(429, { 'retry-after': '5' });
    await fixture.fireBeforeProviderRequest();

    expect(fixture.notifySpy).not.toHaveBeenCalled();
  });

  it('aborts the backoff sleep when ctx.signal fires', async () => {
    setFlag(fixture, 'cost-cap-usd-per-m', '5.0');
    setFlag(fixture, 'cost-backoff-max-ms', '60000');
    await activateExtension(fixture);

    fixture.emitEvent('tps:telemetry', makeTpsTelemetry({ rateUsdPerMTokens: 6.0 }));

    const controller = new AbortController();
    fixture.setSignal(controller.signal);

    const promise = fixture.fireBeforeProviderRequest();
    expect(fixture.notifySpy).toHaveBeenCalledWith(expect.stringContaining('waiting'), 'warning');

    // Abort before the sleep elapses.
    controller.abort();

    // Should resolve immediately (sleep aborted) without advancing timers.
    await promise;
  });

  it('resolves the backoff sleep immediately when ctx.signal is already aborted', async () => {
    setFlag(fixture, 'cost-cap-usd-per-m', '5.0');
    await activateExtension(fixture);

    fixture.emitEvent('tps:telemetry', makeTpsTelemetry({ rateUsdPerMTokens: 6.0 }));

    const controller = new AbortController();
    controller.abort(); // already aborted before the request
    fixture.setSignal(controller.signal);

    // Trip fires (notify + status), but sleep returns immediately — no timer advance.
    await fixture.fireBeforeProviderRequest();
    expect(fixture.notifySpy).toHaveBeenCalledWith(expect.stringContaining('waiting'), 'warning');
  });

  it('/cost-backoff reports a pending 429 override before it is consumed', async () => {
    await activateExtension(fixture);

    await fixture.fireAfterProviderResponse(429, { 'retry-after': '3' });
    await fixture.commands['cost-backoff'].handler('', fixture.mockCtx);
    const msg = fixture.notifySpy.mock.calls.at(-1)![0] as string;
    expect(msg).toContain('pending 429 override 3.0s');
  });
});
