<div align="center">

# ⏳ pi-cost-backoff

**Cost-aware request throttling for [pi](https://github.com/earendil-works/pi-coding-agent)**

_Exponential backoff when $/M or $/min exceeds your cap. Companion to [pi-tps](https://github.com/monotykamary/pi-tps)._

[![pi extension](https://img.shields.io/badge/pi-extension-blueviolet)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

## Quick start

```bash
pi install npm:@monotykamary/pi-tps      # the sensor (provides the cost signal)
pi install npm:@monotykamary/pi-cost-backoff
```

Then set a cap and run pi from that directory:

```bash
COST_CAP_USD_PER_MIN=0.50 pi
```

> **Install order:** load `pi-tps` (the sensor) **before** `pi-cost-backoff` so the cost signal is available from the first turn. See [Cost signal](#cost-signal).

## What it is

pi-tps is a **passive sensor**: it measures TPS/cost per turn and emits a `tps:telemetry` event on pi's shared bus. This extension is the **actuator**: it consumes those signals and intentionally *delays the next provider request* when cost metrics exceed your configured thresholds, using exponential backoff with jitter.

Keeping sensor and actuator separate means **pi-tps's TPS measurements stay honest** — the throttle does not perturb the thing it measures, and backoff state never leaks into pi-tps's persisted telemetry.

## Why a separate extension (not a feature of pi-tps)

Bolting active throttling onto a benchmark harness conflates two concerns: *measuring* what the model can do, and *controlling* spend velocity. The split keeps each concern honest, and lets you disable backoff without touching telemetry.

## The triggers

Any of three conditions fires the same exponential backoff on the **next** provider request:

| Trigger | Signal | Honest framing |
| ------- | ------ | -------------- |
| **$/Mtok spike** | `rateUsdPerMTokens` from the prior turn exceeds `--cost-cap-usd-per-m` | A per-turn unit-price anomaly (cache miss, model swap, provider issue). Throttling cannot lower *that* turn's price; it caps the velocity of subsequent expensive turns. Not magic — a velocity lever applied to a price signal. |
| **$/min burn** | Rolling spend velocity over a sliding window exceeds `--cost-cap-usd-per-min` | The coherent "cap spend via backoff" lever: slow the request stream, lower $/min. |
| **429 reactive** | Provider returns 429 in `after_provider_response` (honors `retry-after`) | Composes with pi's built-in transport retry by stashing `retry-after` so the *next* request (across a turn boundary if needed) honors it and escalates the backoff level. |

### $/Mtok vs $/min — which do I want?

- **`--cost-cap-usd-per-min`** is the natural fit for "slow my spend down." Backoff directly lowers $/min.
- **`--cost-cap-usd-per-m`** trips on per-turn unit-price spikes. It does **not** make individual tokens cheaper — backoff only limits how quickly you can rack up expensive turns. Use it as a circuit-breaker against runaway unit cost, not as a price reducer.

Both can be set simultaneously; the spike trigger is evaluated first.

## Configuration

All options are available as CLI flags (registered by the extension) **or** environment variables. Flags win over env.

| Flag | Env | Default | Description |
| ---- | --- | ------- | ----------- |
| `--cost-cap-usd-per-m` | `COST_CAP_USD_PER_M` | disabled | Per-turn $/Mtok spike threshold |
| `--cost-cap-usd-per-min` | `COST_CAP_USD_PER_MIN` | disabled | Rolling $/min burn-rate threshold |
| `--cost-backoff-base-ms` | `COST_BACKOFF_BASE_MS` | `1000` | Base backoff delay (ms), doubled each level |
| `--cost-backoff-max-ms` | `COST_BACKOFF_MAX_MS` | `30000` | Maximum backoff delay (ms) |
| `--cost-backoff-window-ms` | `COST_BACKOFF_WINDOW_MS` | `60000` | Sliding-window length for $/min (ms) |
| `--cost-backoff-decay-ms` | `COST_BACKOFF_DECAY_MS` | `30000` | ms of clean behavior to decay one level |
| `--cost-backoff-disable` | — | `false` | Kill-switch: disables all triggers |

Examples:

```bash
# Cap burn at $0.50/min, env var (no flag prefix)
COST_CAP_USD_PER_MIN=0.50 pi

# Cap unit-price spikes at $5.00/Mtok via flag
pi --cost-cap-usd-per-m 5.00

# Both, with faster decay (10s) and a 60s ceiling
pi --cost-cap-usd-per-m 5.00 --cost-cap-usd-per-min 0.50 \
   --cost-backoff-decay-ms 10000 --cost-backoff-max-ms 60000
```

### Backoff strategy

- **Exponential with jitter:** `delay = min(base · 2^level, max)`, ±20% jitter.
- **Escalation:** consecutive trips bump the level (capped at 8); delay doubles each level.
- **Decay:** every `decay-ms` of clean behavior reduces the level by one (residual clean time is preserved across a decay).
- **429:** honors `retry-after` (delta-seconds or HTTP-date), never below the exponential floor; falls back to 5s when `retry-after` is missing.

Example progression (defaults: base 1s, max 30s, jitter zeroed for clarity):

```
trip 1 → level 1 → 2.0s
trip 2 → level 2 → 4.0s
trip 3 → level 3 → 8.0s
trip 4 → level 4 → 16.0s
trip 5 → level 5 → 30.0s (clamped)
...clean for 30s... → level 4
```

## How it works

The throttle point is pi's `before_provider_request` hook. pi **awaits** this hook before sending the HTTP request, so an `await sleep(N)` here genuinely delays the request (verified in pi's `sdk.js` `onPayload`).

```
turn N                        turn-end cost captured → lastRateUsdPerM / burn window
  └─ tps:telemetry ─────────────►  pi-cost-backoff state
turn N+1
  └─ before_provider_request ──►  evaluate triggers → sleep(delay) if tripped → request fires
  └─ after_provider_response ──► if 429: stash retry-after for the next request
```

### Cost signal

- **Primary:** subscribes to the `tps:telemetry` event emitted by pi-tps, capturing `rateUsdPerMTokens` (spike trigger) and `cost.total` (burn-rate window).
- **Fallback:** if no `tps:telemetry` has ever been seen, reads `message.usage.cost.total` directly in `turn_end`. The fallback **cannot** compute `rateUsdPerMTokens`, so the spike trigger is inactive until pi-tps is observed.
- **Once a single `tps:telemetry` event arrives, the fallback is permanently disabled** (avoids double-counting cost in the burn-rate window when both paths fire for the same turn).

> **Install-order note:** if pi-tps is loaded *after* pi-cost-backoff, the very first turn may double-count its cost in the burn-rate window (after that, telemetry owns it). Load pi-tps first to avoid this — the same graceful-degradation pattern pi-tps itself uses for its Neuralwatt cost handoff.

### Burn-rate computation

`$/min = (sum of costs in the sliding window) / max(elapsed-since-oldest-in-window, 1s) × 60000`

The 1s floor prevents a single recent expensive turn from exploding the rate. The window is pruned as new samples arrive.

## Measurement caveats

- **TTFT absorbs the backoff delay.** `before_provider_request` fires after `turn_start`, so a throttled turn's TTFT (as reported by pi-tps) includes the intentional wait. This is arguably correct — TTFT should reflect an intentional delay.
- **Generation TPS stays honest.** pi-tps measures generation speed `message_start`→`message_end`, entirely after the request fires, so the backoff delay never inflates or deflates generation TPS.
- **No persisted control state.** Backoff level, window, and rate are transient runtime state, re-derived from fresh signals on session resume (no stale lockout risk). The cost window starts empty after a reload.

## Inspecting state

```bash
/cost-backoff
```

Shows current config and live state — armed caps, backoff level, window sample count, last seen $/Mtok, and any pending 429 override. Same output is reflected in the footer status line (`pi-cost-backoff`) while a backoff is active; cleared when the level decays to zero.

## Testing

```bash
npm install
npm test              # 73 tests
npm run test:coverage # 100% lines on index.ts
npm run typecheck
npm run lint:dead     # knip
```

## License

MIT
