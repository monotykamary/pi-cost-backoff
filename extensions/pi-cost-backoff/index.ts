/**
 * pi-cost-backoff — Cost-aware request throttling for pi
 *
 * Companion to pi-tps. pi-tps is a passive *sensor*: it measures TPS/cost per
 * turn and emits `tps:telemetry` on pi's shared event bus. This extension is
 * the *actuator*: it consumes those signals and intentionally delays the next
 * provider request when cost metrics exceed configured thresholds, using
 * exponential backoff with jitter.
 *
 * Keeping sensor and actuator separate means pi-tps's TPS measurements stay
 * honest — the throttle does not perturb the thing it measures. The split also
 * means backoff state never leaks into pi-tps's persisted telemetry.
 *
 * Three triggers (any fires the same exponential backoff):
 *   1. $/Mtok spike — `rateUsdPerMTokens` from the prior turn exceeds cap.
 *      Per-turn unit-price anomaly (cache miss, model swap, provider issue).
 *      Throttling cannot lower *that* turn's price; it caps the velocity of
 *      subsequent expensive turns. Honest framing, not magic.
 *   2. $/min burn   — rolling spend velocity over a sliding window exceeds cap.
 *      This is the coherent "cap spend via backoff" lever: slow the request
 *      stream, lower $/min.
 *   3. 429 reactive — provider rate-limit observed in `after_provider_response`;
 *      honors `retry-after` and escalates the backoff level.
 *
 * Throttle point: `before_provider_request`. pi awaits this hook before
 * sending the HTTP request (verified in pi's sdk.js `onPayload`), so an
 * `await sleep(N)` here genuinely delays the request.
 *
 * Cost signal source: subscribes to the `tps:telemetry` event (primary, gives
 * `rateUsdPerMTokens` + `cost.total`). Falls back to reading
 * `message.usage.cost.total` in `turn_end` when pi-tps has not yet emitted —
 * once a single `tps:telemetry` event is seen, the fallback is permanently
 * disabled (pi-tps owns cost capture from there). The fallback cannot compute
 * `rateUsdPerMTokens`, so the spike trigger is inactive until pi-tps is seen.
 *
 * Measurement note: `before_provider_request` fires after `turn_start`, so any
 * backoff delay is absorbed into pi-tps's TTFT for the throttled turn. This is
 * arguably correct (TTFT should reflect an intentional delay), and pi-tps's
 * generation TPS stays honest regardless.
 */

import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionEvent,
  TurnEndEvent,
} from '@earendil-works/pi-coding-agent';

type AfterProviderResponseEvent = Extract<ExtensionEvent, { type: 'after_provider_response' }>;

/** Event emitted by pi-tps after each turn with structured telemetry. */
const TPS_TELEMETRY_EVENT = 'tps:telemetry';

/** Status key shown in pi's footer. */
const STATUS_KEY = 'pi-cost-backoff';

/** Highest exponential level. base*2^N with base=1s → 256s at level 8, capped by maxMs. */
const MAX_BACKOFF_LEVEL = 8;

/** Default backoff base delay (ms). Doubles each level: 1s, 2s, 4s, 8s, 16s, 30s, 30s... */
const DEFAULT_BASE_MS = 1000;

/** Default backoff cap (ms). */
const DEFAULT_MAX_MS = 30_000;

/** Default sliding-window length for $/min computation (ms). */
const DEFAULT_WINDOW_MS = 60_000;

/** Default ms of clean behavior required to decay one backoff level. */
const DEFAULT_DECAY_MS = 30_000;

/** Default jitter (±fraction of the computed delay). */
const DEFAULT_JITTER_RATIO = 0.2;

/** Minimum elapsed span used when computing burn rate, to avoid single-tick explosion (ms). */
const BURN_RATE_MIN_ELAPSED_MS = 1000;

/** Fallback delay when a 429 arrives without a parseable retry-after (ms). */
const RETRY_AFTER_FALLBACK_MS = 5_000;

export interface BackoffConfig {
  /** Per-turn $/Mtok spike threshold. null = spike trigger disabled. */
  capUsdPerM: number | null;
  /** Rolling $/min burn-rate threshold. null = burn trigger disabled. */
  capUsdPerMin: number | null;
  /** Base delay (ms), doubled each level. */
  baseMs: number;
  /** Maximum delay (ms). */
  maxMs: number;
  /** Sliding-window length for $/min (ms). */
  windowMs: number;
  /** ms of clean behavior to decay one level. */
  decayMs: number;
  /** ±fraction of computed delay applied as jitter. */
  jitterRatio: number;
  /** Master kill-switch (true = no-op). */
  disabled: boolean;
}

export interface CostSample {
  costUsd: number;
  ts: number; // Date.now()
}

export interface BackoffState {
  /** Sliding window of per-turn costs for $/min computation. */
  costWindow: CostSample[];
  /** Most recent per-turn $/Mtok rate from tps:telemetry (spike trigger). */
  lastRateUsdPerM: number | null;
  /** True once any tps:telemetry event has been seen → disable turn_end fallback. */
  tpsTelemetryEverSeen: boolean;
  /** Current exponential backoff level (0 = no backoff). */
  level: number;
  /** Timestamp marking the start of the current clean streak (ms), or null. */
  lastCleanMs: number | null;
  /** One-shot delay (ms) set by a reactive 429; consumed by the next request. */
  reactiveOverrideMs: number | null;
  /** Human-readable reason for the most recent trip, for status display. */
  lastTripReason: string | null;
}

export function createState(): BackoffState {
  return {
    costWindow: [],
    lastRateUsdPerM: null,
    tpsTelemetryEverSeen: false,
    level: 0,
    lastCleanMs: null,
    reactiveOverrideMs: null,
    lastTripReason: null,
  };
}

/**
 * Deterministic exponential backoff delay for a level, before jitter.
 * level 0 → 0ms. Otherwise min(base * 2^level, max). No jitter.
 */
export function computeBackoffDelay(level: number, baseMs: number, maxMs: number): number {
  if (level <= 0) return 0;
  const raw = baseMs * 2 ** level;
  return Math.min(raw, maxMs);
}

/**
 * Add ±jitter to a delay. `rng` injectable for deterministic tests.
 * Returns 0 only when delayMs <= 0.
 */
export function applyJitter(
  delayMs: number,
  jitterRatio: number,
  rng: () => number = Math.random
): number {
  if (jitterRatio <= 0 || delayMs <= 0) return delayMs;
  const jitter = delayMs * jitterRatio;
  const offset = (rng() * 2 - 1) * jitter; // [-jitter, +jitter)
  return Math.max(0, Math.round(delayMs + offset));
}

/**
 * Compute burn rate ($/min) over a sliding window ending at nowMs.
 * = sum(in-window costs) / max(elapsed-since-oldest-in-window, 1s) * 60000.
 * Returns null when the window is empty.
 */
export function computeBurnRateUsdPerMin(
  window: CostSample[],
  nowMs: number,
  windowMs: number
): number | null {
  if (window.length === 0) return null;
  const cutoff = nowMs - windowMs;
  let total = 0;
  let oldest = Infinity;
  let count = 0;
  for (const s of window) {
    if (s.ts >= cutoff) {
      total += s.costUsd;
      if (s.ts < oldest) oldest = s.ts;
      count++;
    }
  }
  if (count === 0) return null;
  const elapsedMs = Math.max(BURN_RATE_MIN_ELAPSED_MS, nowMs - oldest);
  const rate = (total / elapsedMs) * 60_000;
  // Round to 6 decimals to avoid float drift in assertions.
  return Math.round(rate * 1e6) / 1e6;
}

/** Prune samples older than the window. Mutates and returns the window. */
export function pruneWindow(window: CostSample[], nowMs: number, windowMs: number): CostSample[] {
  const cutoff = nowMs - windowMs;
  // In-place filter preserving order.
  let write = 0;
  for (let read = 0; read < window.length; read++) {
    if (window[read].ts >= cutoff) {
      window[write++] = window[read];
    }
  }
  window.length = write;
  return window;
}

/**
 * Parse an HTTP `retry-after` header to milliseconds.
 * Accepts delta-seconds (numeric) or HTTP-date (RFC 7231). Returns null when
 * unparseable.
 */
export function parseRetryAfterMs(header: string | undefined): number | null {
  if (header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed === '') return null;

  // Delta-seconds (HTTP spec): a non-negative integer/decimal.
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && asNum >= 0 && /^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.round(asNum * 1000);
  }

  // HTTP-date: only attempt Date.parse when the string looks like a date —
  // it must contain a letter or colon. This avoids treating stray numeric
  // input (e.g. "-5", "+5") as a (past) date → 0.
  if (/[:a-zA-Z]/.test(trimmed)) {
    const asDate = Date.parse(trimmed);
    if (Number.isFinite(asDate)) {
      const delta = asDate - Date.now();
      return delta > 0 ? Math.round(delta) : 0;
    }
  }
  return null;
}

export type TripKind = 'spike' | 'burn' | 'rate-limit';

export interface Trip {
  kind: TripKind;
  reason: string;
  value: number;
  threshold: number;
}

/**
 * Evaluate trigger conditions against current state. Returns the first tripping
 * trigger (spike takes precedence over burn), or null when none trip.
 */
export function evaluateTriggers(
  state: { lastRateUsdPerM: number | null; costWindow: CostSample[] },
  config: BackoffConfig,
  nowMs: number
): Trip | null {
  // 1. Spike: per-turn $/Mtok exceeds cap.
  if (config.capUsdPerM !== null && state.lastRateUsdPerM !== null) {
    if (state.lastRateUsdPerM > config.capUsdPerM) {
      return {
        kind: 'spike',
        reason: `$/M ${state.lastRateUsdPerM.toFixed(2)} > ${config.capUsdPerM.toFixed(2)}`,
        value: state.lastRateUsdPerM,
        threshold: config.capUsdPerM,
      };
    }
  }
  // 2. Burn: rolling $/min exceeds cap.
  if (config.capUsdPerMin !== null) {
    const rate = computeBurnRateUsdPerMin(state.costWindow, nowMs, config.windowMs);
    if (rate !== null && rate > config.capUsdPerMin) {
      return {
        kind: 'burn',
        reason: `$/min ${rate.toFixed(3)} > ${config.capUsdPerMin.toFixed(3)}`,
        value: rate,
        threshold: config.capUsdPerMin,
      };
    }
  }
  return null;
}

/**
 * Decay the backoff level based on elapsed clean time.
 * - level 0: returns level 0, stamps lastCleanMs to nowMs.
 * - lastCleanMs null (fresh trip): starts the clean timer without decaying.
 * - elapsed >= decayMs: decays floor(elapsed/decayMs) levels, preserving residual time.
 */
export function applyDecay(
  level: number,
  lastCleanMs: number | null,
  nowMs: number,
  decayMs: number
): { level: number; lastCleanMs: number } {
  if (level <= 0) return { level: 0, lastCleanMs: nowMs };
  if (lastCleanMs === null) return { level, lastCleanMs: nowMs };
  const elapsed = nowMs - lastCleanMs;
  if (elapsed < decayMs) return { level, lastCleanMs };
  const levelsToDecay = Math.floor(elapsed / decayMs);
  const newLevel = Math.max(0, level - levelsToDecay);
  const consumed = levelsToDecay * decayMs;
  return { level: newLevel, lastCleanMs: lastCleanMs + consumed };
}

/** Read a non-negative number from a flag (string) or env var. Flag wins. Returns null if unset/invalid. */
function readPositiveNumber(
  getFlag: (name: string) => boolean | string | undefined,
  flagName: string,
  envName: string
): number | null {
  const flagVal = getFlag(flagName);
  let raw: string | undefined;
  if (typeof flagVal === 'string') raw = flagVal;
  if (raw === undefined) raw = process.env[envName];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

export function readConfig(getFlag: (name: string) => boolean | string | undefined): BackoffConfig {
  const disabled = getFlag('cost-backoff-disable') === true;
  const capUsdPerM = readPositiveNumber(getFlag, 'cost-cap-usd-per-m', 'COST_CAP_USD_PER_M');
  const capUsdPerMin = readPositiveNumber(getFlag, 'cost-cap-usd-per-min', 'COST_CAP_USD_PER_MIN');
  const baseMs =
    readPositiveNumber(getFlag, 'cost-backoff-base-ms', 'COST_BACKOFF_BASE_MS') ?? DEFAULT_BASE_MS;
  const maxMsRaw =
    readPositiveNumber(getFlag, 'cost-backoff-max-ms', 'COST_BACKOFF_MAX_MS') ?? DEFAULT_MAX_MS;
  const windowMs =
    readPositiveNumber(getFlag, 'cost-backoff-window-ms', 'COST_BACKOFF_WINDOW_MS') ??
    DEFAULT_WINDOW_MS;
  const decayMs =
    readPositiveNumber(getFlag, 'cost-backoff-decay-ms', 'COST_BACKOFF_DECAY_MS') ??
    DEFAULT_DECAY_MS;
  // maxMs must be at least baseMs, otherwise backoff could yield sub-base delays.
  const maxMs = Math.max(maxMsRaw, baseMs);
  return {
    capUsdPerM,
    capUsdPerMin,
    baseMs,
    maxMs,
    windowMs,
    decayMs,
    jitterRatio: DEFAULT_JITTER_RATIO,
    disabled,
  };
}

/** Minimal projection of pi-tps's TurnTelemetry payload (see pi-tps README). */
interface TpsTelemetrySignal {
  rateUsdPerMTokens?: number | null;
  cost?: { total?: number | null } | null;
  timestamp?: number;
}

/** Read `cost.total` from a turn_end assistant message. Returns null if unavailable. */
function readCostFromTurnEndMessage(message: unknown): number | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  if (msg.role !== 'assistant') return null;
  const usage = msg.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') return null;
  const cost = usage.cost as Record<string, unknown> | undefined;
  if (!cost || typeof cost !== 'object') return null;
  const total = cost.total;
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) return null;
  return total;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function describeConfig(config: BackoffConfig): string {
  if (config.disabled) return 'disabled (--cost-backoff-disable)';
  const caps: string[] = [];
  if (config.capUsdPerM !== null) caps.push(`$/M≤${config.capUsdPerM}`);
  if (config.capUsdPerMin !== null) caps.push(`$/min≤${config.capUsdPerMin}`);
  if (caps.length === 0) return 'armed with no caps (no-op)';
  const tuning = `base ${formatSeconds(config.baseMs)}s · max ${formatSeconds(config.maxMs)}s · window ${formatSeconds(config.windowMs)}s · decay ${formatSeconds(config.decayMs)}s`;
  return `armed: ${caps.join(', ')} · ${tuning}`;
}

export default function costBackoffExtension(pi: ExtensionAPI) {
  // Register CLI flags so they're recognized on the command line and readable
  // via getFlag. pi's getFlag returns undefined unless the calling extension
  // itself registered the flag, so registration is mandatory. Numeric config
  // uses string flags so values like "5.00" can be passed; the kill-switch is
  // boolean.
  pi.registerFlag('cost-cap-usd-per-m', {
    description: 'Per-turn $/Mtok spike threshold; trips backoff when exceeded',
    type: 'string',
  });
  pi.registerFlag('cost-cap-usd-per-min', {
    description: 'Rolling $/min burn-rate threshold; trips backoff when exceeded',
    type: 'string',
  });
  pi.registerFlag('cost-backoff-base-ms', {
    description: 'Base backoff delay in ms (doubles each level)',
    type: 'string',
  });
  pi.registerFlag('cost-backoff-max-ms', {
    description: 'Maximum backoff delay in ms',
    type: 'string',
  });
  pi.registerFlag('cost-backoff-window-ms', {
    description: 'Sliding window length in ms for $/min computation',
    type: 'string',
  });
  pi.registerFlag('cost-backoff-decay-ms', {
    description: 'ms of clean behavior to decay one backoff level',
    type: 'string',
  });
  pi.registerFlag('cost-backoff-disable', {
    description: 'Disable all cost-backoff triggers (kill-switch)',
    type: 'boolean',
    default: false,
  });

  // Config is read lazily on first handler invocation: CLI flag values are
  // applied to the runtime at session start, which runs *after* the factory,
  // so reading at factory time would miss them. Env-var fallback also needs
  // process.env to be stable, which it is by first handler invocation. Cached
  // after first read; flag values are launch-time config, so a mid-session
  // change requires /reload.
  let cachedConfig: BackoffConfig | null = null;
  const getConfig = (): BackoffConfig => {
    if (cachedConfig) return cachedConfig;
    cachedConfig = readConfig((name) => pi.getFlag(name));
    return cachedConfig;
  };

  const state = createState();

  // pi-tps emits this after each turn. We capture the blended $/Mtok rate
  // (spike trigger) and the turn's total cost (burn-rate window). Once seen,
  // the turn_end fallback is permanently disabled — pi-tps owns cost capture.
  pi.events.on(TPS_TELEMETRY_EVENT, (payload: unknown) => {
    const config = getConfig();
    if (!payload || typeof payload !== 'object') return;
    const t = payload as TpsTelemetrySignal;

    const rate = t.rateUsdPerMTokens;
    if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0) {
      state.lastRateUsdPerM = rate;
    }

    const total = t.cost?.total;
    if (typeof total === 'number' && Number.isFinite(total) && total >= 0) {
      const ts = typeof t.timestamp === 'number' ? t.timestamp : Date.now();
      state.costWindow.push({ costUsd: total, ts });
      pruneWindow(state.costWindow, Date.now(), config.windowMs);
    }

    state.tpsTelemetryEverSeen = true;
  });

  // Reads message.usage.cost.total directly. Cannot compute rateUsdPerMTokens,
  // so the spike trigger stays inactive in fallback mode. Disabled permanently
  // once any tps:telemetry event arrives (avoids double-counting cost in the
  // burn-rate window when both paths fire for the same turn).
  pi.on('turn_end', (event: TurnEndEvent) => {
    if (state.tpsTelemetryEverSeen) return;
    const cost = readCostFromTurnEndMessage(event.message);
    if (cost !== null) {
      state.costWindow.push({ costUsd: cost, ts: Date.now() });
      pruneWindow(state.costWindow, Date.now(), getConfig().windowMs);
    }
  });

  // pi's transport already retries transport-level 429s; this composes by
  // stashing the retry-after so the *next* request (potentially across a turn
  // boundary) honors it. No level bump or notify here — before_provider_request
  // consumes the override, escalates the level, and notifies when it actually
  // backs off. This avoids spurious notifications when pi's transport retries
  // the 429 internally and succeeds.
  pi.on('after_provider_response', (event: AfterProviderResponseEvent) => {
    if (getConfig().disabled) return;
    if (event.status !== 429) return;

    const retryAfterMs = parseRetryAfterMs(event.headers['retry-after']) ?? RETRY_AFTER_FALLBACK_MS;
    state.reactiveOverrideMs = Math.max(state.reactiveOverrideMs ?? 0, retryAfterMs);
    state.lastTripReason = `429 rate-limited · retry-after ${formatSeconds(retryAfterMs)}s`;
  });

  // pi awaits this hook before sending the HTTP request, so an awaited sleep
  // here genuinely delays the request.
  pi.on('before_provider_request', async (_event: BeforeProviderRequestEvent, ctx) => {
    const config = getConfig();
    if (config.disabled) return;

    const nowMs = Date.now();

    // Consume any reactive 429 override (one-shot).
    const overrideMs = state.reactiveOverrideMs;
    state.reactiveOverrideMs = null;

    const trip = evaluateTriggers(state, config, nowMs);

    // Clean path: no override, no trip → decay the level.
    if (overrideMs === null && trip === null) {
      const decayed = applyDecay(state.level, state.lastCleanMs, nowMs, config.decayMs);
      state.level = decayed.level;
      state.lastCleanMs = decayed.lastCleanMs;
      if (state.level === 0 && state.lastTripReason !== null) {
        state.lastTripReason = null;
        if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      }
      return;
    }

    // Trip path: escalate one level, compute delay.
    state.level = Math.min(state.level + 1, MAX_BACKOFF_LEVEL);
    state.lastCleanMs = null;

    let delayMs: number;
    if (overrideMs !== null) {
      // Reactive 429: honor retry-after, but never go below the exponential floor.
      delayMs = Math.max(overrideMs, computeBackoffDelay(state.level, config.baseMs, config.maxMs));
    } else {
      delayMs = computeBackoffDelay(state.level, config.baseMs, config.maxMs);
      state.lastTripReason = trip!.reason;
    }
    delayMs = applyJitter(delayMs, config.jitterRatio);

    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, `backoff ${formatSeconds(delayMs)}s · ${state.lastTripReason}`);
      ctx.ui.notify(
        `cost backoff: ${state.lastTripReason} → waiting ${formatSeconds(delayMs)}s`,
        'warning'
      );
    }

    await sleep(delayMs, ctx.signal);
  });

  pi.registerCommand('cost-backoff', {
    description: 'Show current cost-backoff config and live backoff state',
    handler: async (_args, ctx) => {
      const config = getConfig();
      const lines: string[] = [];
      lines.push(describeConfig(config));
      lines.push(
        `level ${state.level} · window ${state.costWindow.length} samples · last $/M ${state.lastRateUsdPerM?.toFixed(2) ?? '—'}`
      );
      if (state.reactiveOverrideMs !== null) {
        lines.push(`pending 429 override ${formatSeconds(state.reactiveOverrideMs)}s`);
      }
      if (ctx.hasUI) ctx.ui.notify(lines.join('\n'), 'info');
    },
  });
}
