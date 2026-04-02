# API_CONTRACT.md — Backend ↔ Frontend Data Contract

**Single source of truth for all data exchanged between the Python backend and the Rust frontend.**
This file must live in both repos. Any change to an endpoint's response format, units, or behavior MUST be reflected here FIRST, then in both CLAUDE.md files.

Last verified against backend code: April 1, 2026

---

## Symbols

| Valid Symbols | `BTC`, `ETH`, `SOL` |
|---------------|----------------------|
| Backend accepts | Both short (`BTC`) and full (`BTCUSDT`) — `_validate_symbol()` strips USDT suffix, uppercases |
| Frontend sends | Short symbols (`BTC`) for AGGREGATED tickers; full symbols (`BTCUSDT`) for single-exchange tickers |
| Invalid symbol | HTTP 400 with `{"detail": "Invalid symbol 'XRP'. Valid symbols: BTC, ETH, SOL"}` |
| Warming up | HTTP 503 with `{"detail": "Data for ETH is warming up, please try again shortly."}` — transient, retry after 5-10s |

---

## Backend Base URL

**Production:** `http://api.tradenet.org:8899`
**Frontend constant:** `BACKEND_API_BASE` in `exchange/src/lib.rs`

The backend uses **clean primary paths** (e.g., `/oi`, `/liq_events`). Old `/v1/`, `/v2/`, `/v3/` paths are kept as aliases. Both work identically. The frontend currently uses a mix — new code should prefer clean paths.

**⚠️ KNOWN INCONSISTENCY:** The `/oi` endpoint has **NO** `/v2/oi` alias. The frontend previously hit `/v2/oi` which returned 404. This was fixed (bug fix #12 in the roadmap). Always use `/oi` directly.

---

## Endpoints Used by AGGREGATED Tickers

These are the endpoints where frontend↔backend bugs are most likely. Each entry is the verified contract.

---

### GET `/oi?symbol=BTC`

**Purpose:** Live aggregated open interest from 3 exchanges (Binance, Bybit, OKX).
**Poll interval:** Backend polls exchanges every 5 seconds. Frontend polls this endpoint every 5 seconds for bar stats OI Delta/CVD (rows 5-6).
**Cache:** 5s TTL on backend.
**Alias:** None — `/oi` only, no `/v2/oi`.

**Response:**
```json
{
  "symbol": "BTC",
  "aggregated_oi": 170000.50,
  "per_exchange": {
    "binance": 65000.0,
    "bybit": 55000.0,
    "okx": 50000.50
  },
  "previous_oi": 169995.20,
  "oi_delta": 5.30,
  "oi_delta_pct": 0.0031,
  "oi_cvd_utc": 1250000.50,
  "ts": 1708700000.123
}
```

| Field | Type | Unit | Notes |
|-------|------|------|-------|
| `aggregated_oi` | float | **Base asset** (BTC contracts) | Sum of all exchanges. ~170K BTC = ~$14B notional at $84K |
| `per_exchange` | dict | Base asset | Individual exchange values. Keys: `"binance"`, `"bybit"`, `"okx"` |
| `previous_oi` | float or null | Base asset | Previous poll's aggregated OI. `null` on first poll after restart |
| `oi_delta` | float or null | Base asset | `aggregated_oi - previous_oi`. `null` if `previous_oi` is null or zero |
| `oi_delta_pct` | float or null | Percent | `(oi_delta / previous_oi) * 100`, rounded to 4 decimal places. `null` if `previous_oi` is null or zero |
| `oi_cvd_utc` | float | **USD** | Cumulative OI delta since midnight UTC today, converted to USD. Sum of `(oi[i] - oi[i-1]) * current_price` for consecutive readings. Resets to 0 at midnight UTC. 0.0 if no price or no history available |
| `ts` | float | **Seconds** with fractional ms | Unix timestamp of the reading |

**Frontend handling:** `fetch_aggregated_oi()` returns `aggregated_oi` as `f32`. The OI pipeline multiplies by price to convert to USD. The `ts` field is in **seconds** (not ms). The `previous_oi`, `oi_delta`, and `oi_delta_pct` fields should be deserialized with `#[serde(default)]`.

**⚠️ UNIT TRAP:** `aggregated_oi` is in base asset (contracts), NOT USD. A value of 170,000 means 170K BTC ≈ $14.3B. The frontend must multiply by close price for USD display.

---

### GET `/oi_history?symbol=BTC&from={ms}&to={ms}`

**Purpose:** Historical aggregated OI for bar stats OI Delta/CVD backfill.
**Called:** Once on chart load for AGGREGATED tickers. Replaces Binance `/data/openInterestHist`.
**Cache:** 5s TTL on backend.
**Alias:** None — `/oi_history` only.

**Response:**
```json
{
  "symbol": "BTC",
  "timestamps": [1708700000000, 1708700015000, 1708700030000],
  "oi": [170000.50, 170005.12, 169998.30],
  "ts_unit": "ms",
  "oi_unit": "base"
}
```

| Field | Type | Unit | Notes |
|-------|------|------|-------|
| `timestamps` | array of int | **Milliseconds** | Parallel with `oi` array. 5-second resolution. |
| `oi` | array of float | **Base asset** (contracts) | Same unit as live `/oi` `aggregated_oi` field |
| `ts_unit` | string | — | Always `"ms"` |
| `oi_unit` | string | — | Always `"base"` |

**Data source:** In-memory ring buffer per symbol. `deque(maxlen=17280)` = 24 hours at 5-second intervals. **Starts empty on backend restart.** Data only available from process boot time forward.

**Frontend handling:** `fetch_aggregated_oi_history()` in `exchange/src/adapter.rs`. Returns `Vec<OpenInterest>` in contracts. Frontend converts to USD in `update_oi_from_history()` by multiplying by price.

**⚠️ EMPTY AFTER RESTART:** If the backend was recently restarted, this endpoint may return very few or zero entries. The frontend should handle empty responses gracefully and fall back to whatever data is available.

**⚠️ TIMESTAMP MATCHING:** OI readings arrive every 5 seconds. Candle timestamps are at the chart's timeframe interval. The frontend must use **nearest-match** logic (not exact match) when mapping OI to candles. This was a confirmed bug — exact `oi_map.get(&ts)` missed most candles.

---

### GET `/liq_events?symbol=BTC&since_ts={ms}&limit=5000`

**Purpose:** Individual force order (liquidation) events for bar stats rows 7-8 (Short Liq, Long Liq).
**Poll interval:** Frontend polls every 5 seconds (500ms during catch-up backfill).
**Cache:** None — always fresh.
**Alias:** `/v2/liq_events`

**Response:**
```json
{
  "symbol": "BTC",
  "events": [
    {
      "ts": 1708700000123,
      "symbol": "BTC",
      "side": "short",
      "price": 65432.10,
      "qty": 0.5,
      "notional_usd": 32716.05,
      "exchange": "binance"
    }
  ],
  "count": 42,
  "oldest_available_ts": 1708696400000,
  "newest_ts": 1708700000123,
  "ts_unit": "ms"
}
```

| Field | Type | Unit | Notes |
|-------|------|------|-------|
| `symbol` | string | — | Top-level symbol echo |
| `events[].ts` | int | **Milliseconds** | Event timestamp |
| `events[].symbol` | string | — | Symbol short name (e.g. `"BTC"`) — included in each event |
| `events[].side` | string | — | `"short"` or `"long"` — the **position** that was liquidated |
| `events[].price` | float | USD | Liquidation price |
| `events[].qty` | float | Base asset | Position size |
| `events[].notional_usd` | float | USD | `qty * price` |
| `events[].exchange` | string | — | `"binance"`, `"bybit"`, or `"okx"` |
| `count` | int | — | Number of events **returned in this response** (after filtering/slicing), NOT total buffer size |
| `oldest_available_ts` | int | ms | Oldest event in **returned** set (0 if empty) |
| `newest_ts` | int | ms | Most recent event in returned set — **use as cursor for next poll** (0 if empty) |

**Pagination:** `since_ts` is an **exclusive lower bound** — returns events with `ts > since_ts`. To page forward: set `since_ts = newest_ts` from previous response. Always advance the cursor, even if you got `limit` events back.

**Data source:** In-memory deque per symbol, `maxlen=12000`. **Starts empty on backend restart.**

**Frontend handling:** Per-symbol `LiqPollingState` in `main.rs` tracks cursor (`last_seen_ts`) and dedup `HashSet`. Events bucketed into candle timestamps via `add_liq_events()`.

**⚠️ SIDE SEMANTICS:** `"short"` means a short position was liquidated (forced buy). `"long"` means a long position was liquidated (forced sell). This matches Coinglass convention.

**⚠️ CURSOR PROTOCOL:** Always advance cursor to `newest_ts`. The earlier "don't advance when batch is full" approach was wrong — `since_ts` is exclusive, so advancing is correct and prevents re-fetching the same events. Use rapid polling (500ms) during catch-up instead.

---

### GET `/liq_heatmap_v2?symbol=BTC`

**Purpose:** Live liquidation prediction heatmap — the unique feature.
**Poll interval:** Frontend fetches on toggle, then relies on history endpoint for the grid.
**Cache:** 5s TTL.
**Alias:** `/v2/liq_heatmap`
**Optional param:** `min_notional` (float) — filter out clusters below this USD notional.

**Response:**
```json
{
  "symbol": "BTC",
  "ts": 1708700060.5,
  "price": 66362.0,
  "range_pct": 0.10,
  "long_levels": [
    {
      "price": 65400.0,
      "price_low": 65200.0,
      "price_high": 65600.0,
      "notional_usd": 500000.0,
      "intensity": 0.85,
      "bucket_count": 12,
      "source": "combined"
    }
  ],
  "short_levels": ["same structure"],
  "meta": {
    "tape_weight": 0.35,
    "projection_weight": 0.65,
    "force_orders_total": 2543,
    "inferences_total": 358,
    "cluster_radius_pct": 0.005,
    "min_notional_usd": 1000.0,
    "long_pools_count": 8,
    "short_pools_count": 12,
    "raw_long_buckets": 116,
    "raw_short_buckets": 183
  },
  "stats": { "...": "heatmap engine stats" },
  "src": 66362.0,
  "step": 20.0,
  "price_min": 59740.0,
  "price_max": 73000.0,
  "prices": [59740.0, 59760.0, "..."],
  "long_intensity": [0, 0, 50, 120, "..."],
  "short_intensity": [100, 30, 0, "..."],
  "long_notional_usd": [0.0, 0.0, 50000.0, "..."],
  "short_notional_usd": [100000.0, 30000.0, "..."],
  "long_size_btc": [0.0, 0.0, 0.00075, "..."],
  "short_size_btc": [0.0015, 0.00045, "..."]
}
```

**Clustered levels (primary display data):**

| Field | Type | Unit | Notes |
|-------|------|------|-------|
| `symbol` | string | — | Symbol echo |
| `ts` | float | **Seconds** | Snapshot generation timestamp |
| `price` | float | USD | Current mark price |
| `range_pct` | float | — | Price range fraction (default 0.10 = ±10%) |
| `*_levels[].price` | float | USD | Cluster center price (notional-weighted centroid) |
| `*_levels[].price_low` | float | USD | Cluster lower bound |
| `*_levels[].price_high` | float | USD | Cluster upper bound |
| `*_levels[].notional_usd` | float | USD | Total predicted liquidation value in this cluster |
| `*_levels[].intensity` | float | 0.0–1.0 | Normalized intensity (sqrt-scaled, 1.0 = strongest) |
| `*_levels[].bucket_count` | int | — | Raw buckets merged into this cluster |
| `*_levels[].source` | string | — | `"tape"`, `"inference"`, or `"combined"` |
| `meta` | object | — | Engine metadata (pool counts, raw bucket counts, config) |

**Grid arrays (for history buffer feeding — also useful for custom rendering):**

| Field | Type | Unit | Notes |
|-------|------|------|-------|
| `src` | float | USD | Source price (same as `price`) |
| `step` | float | USD | Price bucket size (BTC=20.0, ETH=1.0, SOL=0.10) |
| `price_min` / `price_max` | float | USD | Grid bounds |
| `prices` | array of float | USD | Price grid levels |
| `long_intensity` / `short_intensity` | array of float | 0–255 | u8 intensity per price bucket (parallel with `prices`) |
| `long_notional_usd` / `short_notional_usd` | array of float | USD | Raw notional per bucket |
| `long_size_btc` / `short_size_btc` | array of float | Base asset | Size per bucket (`notional / price`) |
| `stats` | object | — | Heatmap engine stats (total events, inferences, tape/inference bucket counts) |

**Frontend struct:** `LiveSnapshot` in `src/chart/liq_heatmap.rs`. Use `#[serde(default)]` for fields not yet consumed.

**⚠️ RECENTLY FIXED:** Clustering was collapsing all buckets into 1 level per side due to greedy chain-merge bug. Fixed March 30 — now uses seed price comparison. Should return multiple levels per side.

---

### GET `/liq_heatmap_v2_history?symbol=BTC&minutes=720&stride=1`

**Purpose:** Historical liq heatmap intensity grid for chart overlay rendering.
**Cache:** 30s TTL.
**Alias:** `/v2/liq_heatmap_history`

**Response:**
```json
{
  "t": [1708700000000, 1708700060000],
  "prices": [64000.0, 64020.0, 64040.0],
  "long": [0, 50, 120, 0, 80, 200],
  "short": [100, 30, 0, 150, 40, 0],
  "step": 20.0,
  "scale": 255,
  "_mode": "embedded"
}
```

| Field | Type | Unit | Notes |
|-------|------|------|-------|
| `t` | array of int | ms | One timestamp per frame |
| `prices` | array of float | USD | Price grid levels |
| `long` / `short` | array of int | 0–255 | Flat `[frames × prices]` intensity grid. Row-major: `grid[frame_idx * len(prices) + price_idx]` |
| `step` | float | USD | Price bucket size (BTC=20.0, ETH=1.0, SOL=0.10) |
| `scale` | int | — | Always 255 |
| `_mode` | string | — | Always `"embedded"` |

**⚠️ NO USD ARRAYS:** This endpoint does **not** return `long_usd` or `short_usd`. Only u8 intensity values are available. If the frontend needs USD values, use the live `/liq_heatmap_v2` endpoint's `long_notional_usd`/`short_notional_usd` arrays.

**Parameters:** `minutes` (5–720, default 720), `stride` (1–30, default 1). Both are clamped server-side.

**Frontend struct:** `HistoryResponse` in `src/chart/liq_heatmap.rs`.

---

### GET `/orderbook_heatmap?symbol=BTC`

**Purpose:** Live orderbook depth frame.
**Cache:** 5s TTL (JSON only). Binary format (`format=bin`) bypasses cache.
**Alias:** `/v2/orderbook_heatmap_30s`
**Optional params:** `range_pct` (0–1.0, default 0.10), `step` (>0, auto-resolved per symbol if omitted), `price_min`/`price_max` (USD), `format` (`json` or `bin`).

**Response (JSON):**
```json
{
  "symbol": "BTC",
  "ts": 1708700000.0,
  "src": 66000.0,
  "step": 20.0,
  "price_min": 63000.0,
  "price_max": 69000.0,
  "prices": [63000.0, 63020.0],
  "bid_u8": [50, 120],
  "ask_u8": [80, 30],
  "norm_p50": 10000.0,
  "norm_p95": 500000.0,
  "total_bid_notional": 15000000.0,
  "total_ask_notional": 14000000.0,
  "scale": 255,
  "frame_ts_ms": 1708700000000,
  "frame_interval_ms": 30000,
  "valid_from_ts_ms": 1708700000000,
  "valid_to_ts_ms": 1708700030000,
  "bid_p50": 5000.0,
  "bid_p95": 250000.0,
  "bid_max": 500000.0,
  "ask_p50": 4500.0,
  "ask_p95": 230000.0,
  "ask_max": 480000.0,
  "norm_p90": 400000.0,
  "norm_p99": 600000.0,
  "norm_max": 800000.0,
  "_mode": "shared_buffer"
}
```

| Field | Type | Unit | Notes |
|-------|------|------|-------|
| `ts` | float | **Seconds** | Legacy epoch timestamp |
| `src` | float | USD | Mid price |
| `prices` | array of float | USD | Price grid levels |
| `bid_u8` / `ask_u8` | array of int | 0–255 | Intensity per price bucket (parallel with `prices`) |
| `norm_p50` / `norm_p95` | float | USD | Combined normalization percentiles |
| `bid_p50`, `bid_p95`, `bid_max` | float | USD | Per-side bid scaling stats |
| `ask_p50`, `ask_p95`, `ask_max` | float | USD | Per-side ask scaling stats |
| `total_bid_notional` / `total_ask_notional` | float | USD | Sum of all bid/ask notional |
| `frame_ts_ms` | int | ms | Frame timestamp in milliseconds |
| `frame_interval_ms` | int | ms | Always 30000 (30s frames) |
| `valid_from_ts_ms` / `valid_to_ts_ms` | int | ms | Frame validity window |
| `scale` | int | — | Always 255 |

**Frontend struct:** `LiveSnapshot` in `src/chart/orderbook_heatmap.rs`. Use `#[serde(default)]` for per-side stats fields.

**Note:** OB data source is Binance depth stream for all 3 symbols. All symbols (BTC, ETH, SOL) are supported with per-symbol orderbook engines.

---

### GET `/orderbook_heatmap_history?symbol=BTC&minutes=720&stride=1&range_pct=0.10`

**Purpose:** Historical orderbook depth grid.
**Cache:** 30s TTL (JSON only). Binary format bypasses cache.
**Alias:** `/v2/orderbook_heatmap_30s_history`
**Parameters:** `minutes` (5–720), `stride` (1–30), `range_pct`, `step` (auto-resolved if omitted), `format` (`json` or `bin`).

**Response (JSON):**
```json
{
  "t": [1708700000000],
  "prices": [63000.0, 63020.0],
  "bid_u8": [50, 120],
  "ask_u8": [80, 30],
  "step": 20.0,
  "price_min": 63000.0,
  "price_max": 69000.0,
  "scale": 255,
  "norm_method": "p50_p95",
  "frame_interval_ms": 30000,
  "_mode": "shared_buffer"
}
```

| Field | Type | Unit | Notes |
|-------|------|------|-------|
| `t` | array of int | ms | One timestamp per frame |
| `prices` | array of float | USD | Price grid levels |
| `bid_u8` / `ask_u8` | array of int | 0–255 | Flat `[frames × prices]` intensity grid |
| `step` | float | USD | Price bucket size (BTC=20.0, ETH=1.0, SOL=0.10) |
| `scale` | int | — | Always 255 |
| `norm_method` | string | — | `"p50_p95"` — normalization method used |

**⚠️ NO BASE/USD ARRAYS:** This endpoint does **not** return `bid_btc`, `ask_btc`, `bid_usd`, or `ask_usd`. Only u8 intensity values are available.

**Frontend struct:** `HistoryResponse` in `src/chart/orderbook_heatmap.rs`.
**Note:** `step` is auto-resolved per symbol (BTC=20.0, ETH=1.0, SOL=0.10). Frontend no longer needs to send `step` parameter.

---

### GET `/market_data?symbol=BTC`

**Purpose:** Mark price, last price, funding rate, OI in one call.
**Cache:** 5s TTL.
**Alias:** `/v2/market_data`

**Response:**
```json
{
  "symbol": "BTC",
  "mark_price": 66362.0,
  "last_price": 66360.5,
  "funding_rate": 0.0001,
  "next_funding_ts": null,
  "oi_total": 170000.50,
  "oi_per_exchange": {
    "binance": 65000.0,
    "bybit": 55000.0,
    "okx": 50000.50
  },
  "ts": 1708700000123
}
```

| Field | Type | Unit | Notes |
|-------|------|------|-------|
| `mark_price` | float | USD | From markPrice stream (0.0 if unavailable) |
| `last_price` | float | USD | Last close price (0.0 if unavailable) |
| `funding_rate` | float or null | Fraction | e.g. 0.0001 = 0.01%. `null` if unavailable |
| `next_funding_ts` | int or null | ms | Next funding timestamp. Currently always `null` |
| `oi_total` | float | **Base asset** | Aggregated OI from all exchanges (same unit as `/oi`) |
| `oi_per_exchange` | dict | Base asset | Per-exchange breakdown. Empty `{}` if OI poller unavailable |
| `ts` | int | **Milliseconds** | Response timestamp |

**⚠️ TS UNIT DIFFERENCE:** `/market_data` uses **milliseconds** for `ts`. `/oi` uses **seconds**. Be careful when comparing timestamps across endpoints.

---

### GET `/trader_ratios?symbol=BTC`

**Purpose:** Top trader long/short ratios from Binance. **BTC only** — other symbols return HTTP 400.
**Cache:** 5s TTL.
**Alias:** `/v2/trader_ratios`

**Response:**
```json
{
  "symbol": "BTC",
  "top_trader_long_short_account_ratio": 1.23,
  "top_trader_long_short_position_ratio": 0.95,
  "global_long_short_account_ratio": 1.10,
  "ts": 1708700000123,
  "ts_unit": "ms"
}
```

| Field | Type | Unit | Notes |
|-------|------|------|-------|
| `top_trader_long_short_account_ratio` | float or null | Ratio | Top trader account L/S ratio. `null` if unavailable |
| `top_trader_long_short_position_ratio` | float or null | Ratio | Top trader position L/S ratio. `null` if unavailable |
| `global_long_short_account_ratio` | float or null | Ratio | Global account L/S ratio. `null` if unavailable |
| `ts` | int | ms | Response timestamp |
| `ts_unit` | string | — | Always `"ms"` |

---

### GET `/health`

**Purpose:** Server status, exchange connectivity, uptime.
**Cache:** None — always fresh.
**Alias:** `/v1/health`

**Response:**
```json
{
  "ok": true,
  "version": "3.0.0",
  "mode": "embedded",
  "uptime_s": 86400.5,
  "ob_buffers": {
    "BTC": true,
    "ETH": true,
    "SOL": true
  },
  "symbols": {
    "BTC": {
      "v1_available": true,
      "v1_ts": 1708700000.0,
      "v2_available": true,
      "v2_ts": 1708700000.0,
      "v2_history_frames": 720,
      "ob_frames": 1440
    }
  },
  "exchanges": {
    "binance": {"connected": true, "last_message_ts": 1708700000.0},
    "bybit": {"connected": true, "last_message_ts": 1708699999.0},
    "okx": {"connected": true, "last_message_ts": 1708699998.0}
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `ok` | bool | Always `true` if the server is responding |
| `uptime_s` | float | Seconds since API server start (`time.time() - start_time`) |
| `ob_buffers` | dict | Per-symbol boolean — whether OB buffer exists |
| `symbols` | dict | Per-symbol snapshot availability, timestamps, frame counts |
| `exchanges` | dict | Per-exchange connection status and last message time |

---

### GET `/liq_zones?symbol=BTC`

**Purpose:** Active prediction zones from ActiveZoneManager.
**Cache:** 5s TTL.
**Alias:** `/v3/liq_zones`
**Optional params:** `side` (`long`/`short`), `min_leverage` (int), `max_leverage` (int), `min_weight` (float).

**Response:**
```json
{
  "symbol": "BTC",
  "ts": 1708700000.5,
  "zones": [
    {
      "price": 65400.0,
      "side": "long",
      "weight": 2.5,
      "source": "tape",
      "tier_contributions": {"50": 0.8, "100": 0.2},
      "reinforcement_count": 3,
      "created_at": 1708698000.0,
      "last_reinforced_at": 1708699500.0,
      "status": "REINFORCED"
    }
  ],
  "zones_count": 15,
  "summary": {
    "total_weight_long": 12.5,
    "total_weight_short": 8.3,
    "zones_created_total": 45,
    "zones_swept_total": 30
  },
  "filters": {
    "side": null,
    "min_leverage": null,
    "max_leverage": null,
    "min_weight": null
  }
}
```

---

### GET `/liq_zones_summary?symbol=BTC`

**Purpose:** Compact zone summary statistics.
**Cache:** 5s TTL.
**Alias:** `/v3/liq_zones_summary`

Returns the zone manager's summary dict with added `symbol` and `ts` fields. Structure depends on `ActiveZoneManager.get_summary()`.

---

### GET `/liq_zones_heatmap?symbol=BTC`

**Purpose:** Zone data formatted as heatmap levels (similar structure to `/liq_heatmap_v2`).
**Cache:** 5s TTL.
**Alias:** `/v3/liq_heatmap`
**Optional params:** `min_notional` (float), `min_leverage` (int, 5–250), `max_leverage` (int, 5–250), `min_weight` (float).

**Response:**
```json
{
  "symbol": "BTC",
  "ts": 1708700000.5,
  "long_levels": [
    {
      "price": 65400.0,
      "weight": 2.5,
      "notional_usd": 250000.0,
      "tier_contributions": {"50": 0.8, "100": 0.2},
      "reinforcement_count": 3,
      "source": "tape",
      "created_at": 1708698000.0,
      "last_reinforced_at": 1708699500.0
    }
  ],
  "short_levels": ["same structure"],
  "meta": {
    "min_leverage": null,
    "max_leverage": null,
    "min_weight": null,
    "min_notional": 0,
    "filtered": false,
    "long_pools_count": 8,
    "short_pools_count": 12,
    "total_long_weight": 12.5,
    "total_short_weight": 8.3,
    "zones_created": 45,
    "zones_swept": 30
  }
}
```

---

### GET `/liq_stats?symbol=BTC`

**Purpose:** Heatmap engine statistics (tape events, inferences, bucket counts).
**Cache:** 5s TTL.
**Alias:** `/v2/liq_stats`

Returns the V2 snapshot's `stats` object with added `symbol`, `snapshot_ts`, `snapshot_age_s`, and `history_frames` fields. Exact stats fields depend on `LiquidationHeatmap.get_stats()`.

---

## Aggr-Server Endpoints (proxy.tradenet.org)

These endpoints are used by AGGREGATED tickers for trade data and footprint.

---

### GET `/aggr/footprint/{symbol}/{from_ms}/{to_ms}/{timeframe_ms}`

**Purpose:** Pre-aggregated footprint + OHLCV from 4 exchanges.
**Max range:** 12 hours.
**Optional query:** `?tick_size=5.0` (defaults: BTC=$5, ETH=$0.50, SOL=$0.05)

**Response:**
```json
{
  "symbol": "BTC",
  "timeframe": 900000,
  "tick_size": 5.0,
  "cvd_24h": 1234567.89,
  "cvd_24h_ts": 1708700000000,
  "candles": [
    {
      "ts": 1773290400000,
      "open": 69350.0,
      "high": 69520.0,
      "low": 69310.0,
      "close": 69480.0,
      "vol_buy": 145230.50,
      "vol_sell": 132870.25,
      "cvd": 12360.25,
      "levels": [
        [69310.0, 2.31, 1.87, 45, 38]
      ]
    }
  ]
}
```

| Field | Type | Unit | Notes |
|-------|------|------|-------|
| `cvd_24h` | float | **USD** | Rolling 24h cumulative volume delta (buy vol - sell vol) across all 4 exchanges. Same value as `/cvd/{symbol}` endpoint. |
| `cvd_24h_ts` | int | **Milliseconds** | Timestamp of CVD computation |
| `candles[].vol_buy/vol_sell` | float | **USD** | USD notional from 4 exchanges |
| `candles[].cvd` | float | **USD** | Running cumulative volume delta (vol_buy - vol_sell) from first candle in response. Frontend can anchor to `cvd_24h` via offset. |
| `candles[].levels[][1-2]` | float | **Base asset** | Buy/sell volume per price level in base |
| `candles[].levels[][3-4]` | int | — | Buy/sell trade count |
| `candles[].open/high/low/close` | float or null | USD | Null only if candle has zero data from both sources (extremely rare). See incomplete candle note below. |

**⚠️ VOLUME UNIT MISMATCH:** Candle-level `vol_buy/vol_sell` are in **USD**. Level-level volumes are in **base asset**. The frontend stores `Kline.volume` as `(buy, sell)` — for AGGREGATED panes, these are already USD from this endpoint. For Binance kline backfill of older candles, volumes are base asset and get converted to USD at insertion time in `insert_hist_klines()`.

**⚠️ INCOMPLETE (CURRENT) CANDLE:** The OHLCV bar cascade resamples every 60 seconds, but raw trades (used for levels) are written every 10 seconds. For the current candle period, levels may have data before the bar cascade does. When this happens, the server derives OHLCV from the levels: `vol_buy`/`vol_sell` are computed by summing `level_buy_vol * level_price` across all levels (base→USD), and OHLC is taken from the sorted level prices (open/low = lowest price bucket, high/close = highest price bucket). This is approximate (price-bucket resolution, not tick-level) but makes the candle self-consistent. The frontend should overwrite OHLC with live trade data as it arrives.

---

### GET `/aggr/cvd/{symbol}`

**Purpose:** Rolling 24-hour cumulative volume delta (buy volume minus sell volume) in USD across all 4 exchanges.
**Update rate:** Every ~10 seconds from live trade data, reconciled against the bar cascade every 5 minutes.
**Cache:** None — pure in-memory ring buffer read (no DB query, no TTL).

**Parameters:**

| Parameter | Type | Location | Required | Description |
|-----------|------|----------|----------|-------------|
| `symbol` | string | URL path | Yes | `BTC`, `ETH`, or `SOL` (case-insensitive) |

**Response (200):**
```json
{
  "symbol": "BTC",
  "cvd_24h": 1234567.89,
  "cvd_24h_ts": 1708700000000
}
```

| Field | Type | Unit | Notes |
|-------|------|------|-------|
| `symbol` | string | — | Echoed back, uppercased |
| `cvd_24h` | float | **USD** | Rolling 24h cumulative volume delta (buy vol - sell vol) across Binance, Bybit, OKX, Hyperliquid |
| `cvd_24h_ts` | int | **Milliseconds** | Timestamp of computation |

**Error responses:**
- `400` — Invalid symbol (not BTC/ETH/SOL)
- `501` — No compatible storage configured
- `500` — CVD not yet seeded or internal error

**Examples:** `GET /cvd/btc`, `GET /cvd/ETH`, `GET /cvd/sol`

No query parameters. No authentication beyond existing origin check.

**Frontend handling:** Poll every 15 seconds for AGGREGATED tickers alongside the OI poll. Display `cvd_24h` directly in the 12H CVD row (row 5) of bar stats for the current candle. For historical candles' CVD cells, use per-candle delta sums from trade data.

**⚠️ DATA SOURCE:** Computed from an in-memory accumulator updated on every trade batch (~10s). Reconciled against the bar cascade every 5 minutes. Starts empty on restart and seeds from InfluxDB bar cascade on first reconciliation.

---

### WebSocket `wss://proxy.tradenet.org/aggr/ws`

**Purpose:** Live aggregated trades from 4 exchanges.
**Subscribe:** `{"subscribe":"BTC"}`
**Message format:** `{"symbol":"BTC","trades":[[ts_ms, price, size, side, exchange], ...]}`
- `side`: 0=buy, 1=sell
- `exchange`: exchange identifier string

---

## In-Memory Buffer Limitations

Both the backend and aggr-server have data that **starts empty on restart** and accumulates over time:

| Buffer | Location | Max Depth | Resolution | Impact on Frontend |
|--------|----------|-----------|------------|-------------------|
| OI history | Backend `_oi_history` deque | 24 hours | 5s | No historical OI for AGGREGATED bar stats beyond buffer depth |
| Liq events | Backend `_liq_events` deque | 12,000 events | Event-driven | No liq backfill for candles older than oldest event in buffer |
| Raw trades | Aggr-server InfluxDB `aggr_raw` | 12 hours | Tick-level | No footprint data beyond 12h |
| CVD accumulator | Aggr-server in-memory | 24 hours | ~10s updates | `cvd_24h` is 0 on restart until first bar cascade reconciliation (~5min) |
| Liq heatmap history | Backend binary buffer | ~720 frames | 1 per minute | ~12 hours of heatmap overlay |
| OB heatmap history | Backend binary buffer | ~1440 frames | 1 per 30s | ~12 hours of OB overlay |

**After a backend restart**, OI history and liq events are empty. The frontend will see zero OI delta/CVD and zero liq data until the buffers refill. This is expected behavior, not a bug. The frontend should handle empty/short responses gracefully.

---

## Known Inconsistencies and Notes

1. **`/oi` and `/oi_history` have no `/v2/` aliases.** Backend CLAUDE.md correctly shows `/oi` and `/oi_history` with no aliases. Frontend previously used `/v2/oi` which 404'd. Fixed as bug #12. New code must use `/oi` and `/oi_history` directly.

2. **V1 liq heatmap history is removed.** Backend returns 503 for `/liq_heatmap_history`. V1 binary files are deleted on startup. Frontend should not request V1 history.

3. **`/health` `uptime_s` field.** Computed as `time.time() - state.start_time` (seconds since API thread started). The field name is `uptime_s` (float seconds), NOT hours. If the frontend displays "0.0 hours" it may be a unit conversion issue on the frontend side — the backend value is correct.

4. **Liq heatmap `source` field.** Present on every level in `/liq_heatmap_v2` responses. Values: `"tape"`, `"inference"`, or `"combined"`. The frontend should deserialize it with `#[serde(default)]` if it wants to use it for display.

5. **OB heatmap `step` parameter.** Backend auto-resolves per symbol (BTC=20.0, ETH=1.0, SOL=0.10) if omitted, but still accepts it if sent. Frontend no longer needs to send it.

6. **Timestamp unit inconsistency across endpoints.** `/oi` uses **seconds** for `ts`. `/market_data` and `/trader_ratios` use **milliseconds**. `/liq_events` and history endpoints use **milliseconds**. Always check the endpoint-specific docs above.

7. **`/liq_heatmap_v2_history` has no USD arrays.** The endpoint only returns u8 intensity grids (`long`/`short`). There are no `long_usd`/`short_usd` fields. Similarly, `/orderbook_heatmap_history` has no `bid_btc`/`ask_btc`/`bid_usd`/`ask_usd` fields.

---

## Rules

1. **Any endpoint response format change → update this file FIRST, then both CLAUDE.md files.**
2. **Any new endpoint → add to this file with full response schema before frontend integration.**
3. **Units must be explicitly stated** — never assume USD vs base asset vs contracts.
4. **Timestamps must specify ms vs seconds** — the backend uses both (ms for events/history, seconds for `/oi` ts field).
5. **All optional fields use `#[serde(default)]` on the frontend** — backend may add fields without breaking the parser.
6. **Test with `curl` before writing frontend code** — never trust documentation alone (NEVER DO rule #7).
