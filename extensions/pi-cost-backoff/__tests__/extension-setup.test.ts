import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestFixture, activateExtension } from './helpers';

describe('pi-cost-backoff extension — setup', () => {
  let fixture: ReturnType<typeof createTestFixture>;

  beforeEach(async () => {
    fixture = createTestFixture();
    await activateExtension(fixture);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers the actuator + reactive + fallback event handlers', () => {
    const { mockPi } = fixture;
    expect(mockPi.on).toHaveBeenCalledWith('before_provider_request', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('after_provider_response', expect.any(Function));
    expect(mockPi.on).toHaveBeenCalledWith('turn_end', expect.any(Function));
  });

  it('subscribes to the tps:telemetry event on the shared bus', () => {
    expect(fixture.eventsOnSpy).toHaveBeenCalledWith('tps:telemetry', expect.any(Function));
  });

  it('registers all config flags', () => {
    const { registerFlagSpy } = fixture;
    const registered = registerFlagSpy.mock.calls.map((c) => c[0]);
    expect(registered).toEqual(
      expect.arrayContaining([
        'cost-cap-usd-per-m',
        'cost-cap-usd-per-min',
        'cost-backoff-base-ms',
        'cost-backoff-max-ms',
        'cost-backoff-window-ms',
        'cost-backoff-decay-ms',
        'cost-backoff-disable',
      ])
    );
    for (const [, opts] of registerFlagSpy.mock.calls) {
      expect(typeof opts.description).toBe('string');
      expect(opts.type).toMatch(/^(boolean|string)$/);
    }
  });

  it('registers the /cost-backoff inspection command', () => {
    expect(fixture.registerCommandSpy).toHaveBeenCalledWith(
      'cost-backoff',
      expect.objectContaining({
        description: expect.any(String),
        handler: expect.any(Function),
      })
    );
  });
});
