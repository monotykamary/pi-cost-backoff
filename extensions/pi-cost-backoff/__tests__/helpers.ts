import { vi } from 'vitest';
import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionEvent,
  ExtensionContext,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';

type AfterProviderResponseEvent = Extract<ExtensionEvent, { type: 'after_provider_response' }>;

/** Construct an assistant message with a usage.cost.total, for turn_end fallback tests. */
export function makeAssistantMessageWithCost(opts: {
  costTotal?: number;
  role?: string;
}): Record<string, unknown> {
  const { costTotal = 0.003, role = 'assistant' } = opts;
  return {
    role,
    content: [{ type: 'text', text: 'Hello' }],
    provider: 'openai',
    model: 'gpt-4',
    usage: {
      input: 1000,
      output: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

/** A minimal tps:telemetry payload matching pi-tps's TurnTelemetry shape. */
export function makeTpsTelemetry(opts: {
  rateUsdPerMTokens?: number | null;
  costTotal?: number | null;
  timestamp?: number;
}): Record<string, unknown> {
  const { rateUsdPerMTokens = null, costTotal = null, timestamp = Date.now() } = opts;
  return {
    tps: 10.0,
    isPrimaryBranch: true,
    rateUsdPerMTokens,
    cost:
      costTotal === null
        ? null
        : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
    tokens: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, total: 2000 },
    timing: {
      ttftMs: 1000,
      totalMs: 3000,
      generationMs: 2000,
      streamMs: 2000,
      stallMs: 0,
      stallCount: 0,
      messageCount: 1,
    },
    model: { provider: 'openai', modelId: 'gpt-4' },
    timestamp,
  };
}

export interface TestFixture {
  mockPi: Partial<ExtensionAPI>;
  handlers: Record<string, (...args: unknown[]) => void>;
  commands: Record<
    string,
    { description?: string; handler: (args: string, ctx: any) => Promise<void> }
  >;
  flags: Record<string, boolean | string>;
  notifySpy: ReturnType<typeof vi.fn>;
  setStatusSpy: ReturnType<typeof vi.fn>;
  registerFlagSpy: ReturnType<typeof vi.fn>;
  registerCommandSpy: ReturnType<typeof vi.fn>;
  eventsOnSpy: ReturnType<typeof vi.fn>;
  /** Emit an event on the mock event bus (used to simulate tps:telemetry). */
  emitEvent: (event: string, payload: unknown) => void;
  mockCtx: ExtensionContext;
  /** Set ctx.signal for the next before_provider_request dispatch. */
  setSignal: (signal: AbortSignal | undefined) => void;
  /** Invoke the before_provider_request handler and await it (simulates pi awaiting onPayload). */
  fireBeforeProviderRequest: () => Promise<unknown>;
  /** Invoke the after_provider_response handler (simulates pi awaiting onResponse). */
  fireAfterProviderResponse: (status: number, headers?: Record<string, string>) => Promise<void>;
}

/**
 * Create a fresh set of mocks for one test. Call `activateExtension()` to wire
 * up the extension under test.
 */
export function createTestFixture(): TestFixture {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const commands: Record<
    string,
    { description?: string; handler: (args: string, ctx: any) => Promise<void> }
  > = {};
  const flags: Record<string, boolean | string> = {};
  const notifySpy = vi.fn();
  const setStatusSpy = vi.fn();
  const registerFlagSpy = vi.fn((name: string) => {
    // Flags are pre-seeded into the `flags` map by the test via `setFlag`.
    // Registering just records intent; values are returned by the getFlag stub.
    void name;
  });
  const registerCommandSpy = vi.fn((name: string, options: any) => {
    commands[name] = options;
  });

  let currentSignal: AbortSignal | undefined = undefined;

  const mockCtx = {
    hasUI: true,
    ui: {
      notify: notifySpy,
      setStatus: setStatusSpy,
    } as any,
    sessionManager: {
      getEntries: vi.fn().mockReturnValue([]),
      getBranch: vi.fn(),
      getSessionId: vi.fn(),
    },
    cwd: '/tmp',
    mode: 'tui' as const,
    isIdle: vi.fn(),
    get signal() {
      return currentSignal;
    },
    abort: vi.fn(),
    hasPendingMessages: vi.fn(),
    shutdown: vi.fn(),
    getContextUsage: vi.fn(),
    compact: vi.fn(),
    getSystemPrompt: vi.fn(),
  } as any as ExtensionContext;

  const eventListeners = new Map<string, ((payload: unknown) => void)[]>();
  const dispatchEvent = (event: string, payload: unknown) => {
    for (const listener of eventListeners.get(event) ?? []) {
      try {
        listener(payload);
      } catch {
        // listener errors must not break dispatch in tests
      }
    }
  };

  const eventsOnSpy = vi.fn((event: string, listener: (payload: unknown) => void) => {
    const list = eventListeners.get(event) ?? [];
    list.push(listener);
    eventListeners.set(event, list);
  });

  const mockPi: Partial<ExtensionAPI> = {
    on: vi.fn((event: string, handler: any) => {
      handlers[event] = handler;
      return mockPi as ExtensionAPI;
    }),
    registerCommand: registerCommandSpy,
    registerFlag: registerFlagSpy,
    getFlag: vi.fn((name: string) => flags[name]),
    events: {
      on: eventsOnSpy,
      emit: vi.fn((event: string, payload: unknown) => dispatchEvent(event, payload)),
    } as any,
  };

  return {
    mockPi,
    handlers,
    commands,
    flags,
    notifySpy,
    setStatusSpy,
    registerFlagSpy,
    registerCommandSpy,
    eventsOnSpy,
    emitEvent: dispatchEvent,
    mockCtx,
    setSignal: (signal) => {
      currentSignal = signal;
    },
    fireBeforeProviderRequest: async () => {
      const h = handlers['before_provider_request'];
      if (!h) throw new Error('before_provider_request handler not registered');
      const event: BeforeProviderRequestEvent = { type: 'before_provider_request', payload: {} };
      return await h(event, mockCtx);
    },
    fireAfterProviderResponse: async (status, headers = {}) => {
      const h = handlers['after_provider_response'];
      if (!h) throw new Error('after_provider_response handler not registered');
      const event: AfterProviderResponseEvent = {
        type: 'after_provider_response',
        status,
        headers,
      };
      await h(event, mockCtx);
    },
  };
}

/** Seed a flag value (as if passed on the CLI / env). Must run before activateExtension. */
export function setFlag(fixture: TestFixture, name: string, value: boolean | string): void {
  fixture.flags[name] = value;
}

/** Import the extension module and wire it to the test fixture's mockPi. */
export async function activateExtension(fixture: TestFixture): Promise<void> {
  const { default: costBackoffExtension } = await import('../index.js');
  costBackoffExtension(fixture.mockPi as ExtensionAPI);
}

/** Drive a turn_end with the given message (for fallback cost-capture tests). */
export async function fireTurnEnd(
  fixture: TestFixture,
  message: unknown,
  turnIndex = 0
): Promise<void> {
  const h = fixture.handlers['turn_end'];
  if (!h) throw new Error('turn_end handler not registered');
  const event = { type: 'turn_end', turnIndex, message, toolResults: [] } as TurnEndEvent;
  await h(event, fixture.mockCtx);
}
