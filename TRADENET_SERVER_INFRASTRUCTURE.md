# INFRASTRUCTURE.md — TradeNet Server Architecture

Reference document for how the production infrastructure works. Read alongside BACKEND_CLAUDE.md and FRONTEND_CLAUDE.md.

Last updated: April 23, 2026

---

## Overview

**Single-server consolidated architecture.** One Hetzner CCX23 in Germany hosts everything: the Python backend, aggr-server, InfluxDB, and nginx serving both `api.tradenet.org` and `proxy.tradenet.org` via server_name blocks. The old DigitalOcean Frankfurt droplet was decommissioned on April 22, 2026 after Binance IP-banned its outbound requests (both REST and WebSocket), forcing an emergency same-day migration.

| Component | Domain | Role |
|-----------|--------|------|
| Hetzner CCX23 (Nuremberg) | `api.tradenet.org` | Python backend (liq engine, calibrator, OB reconstructor, FastAPI) |
| Hetzner CCX23 (same box) | `proxy.tradenet.org` | nginx reverse proxy, aggr-server, Velopack update host |
| Hetzner CCX23 (same box) | (internal) | InfluxDB for aggr trade data |

**Specs:** 4 dedicated vCPUs (AMD EPYC), 16GB RAM, 80GB NVMe, 20TB bandwidth.

**Cost:** ~€23/mo (~$25/mo). With Grafana Cloud + Azure Trusted Signing + domain: ~$37/mo total infrastructure.

---

## Why a single box works

All four backend workloads are independent and bounded:

- Python backend: ~15-25% CPU baseline, spikes during active heatmap viewing
- aggr-server: ~7% CPU, trivial
- InfluxDB: ~10% baseline when idle, scales up to 90-120% under active client queries (bar stats polling is the main driver)
- nginx: ~2-5% CPU, serves reverse proxy + releases + TLS

At current beta scale (3-5 concurrent testers), combined load sits comfortably under 400% (4 cores). Upgrade to CCX33 ($50/mo, 8 vCPU, 32GB) or split services to separate boxes when sustained load crosses 60% per core.

---

## Hetzner CCX23 — Services

### Python Backend (api.tradenet.org:8899)

**Purpose:** Runs liquidation prediction engine, calibrator, zone manager, orderbook reconstructor, and serves all analytical data via embedded FastAPI.

**Entry point:** `/opt/tradenet-backend/poc/full_metrics_viewer.py --api --api-host 0.0.0.0 --headless`

**Systemd service:** `/etc/systemd/system/tradenet-backend.service`
```ini
[Unit]
Description=TradeNet Terminal Backend
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/tradenet-backend/poc
Environment=PYTHONUNBUFFERED=1
Environment=API_HOST=0.0.0.0
ExecStart=/usr/bin/python3 full_metrics_viewer.py --api --api-host 0.0.0.0 --headless
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**Binance REST: direct, no proxy.** As of April 16, 2026 (PR #47), Binance unbanned the Hetzner IP and all REST calls (`fapi.binance.com`) go direct. WebSocket streams always went direct. `BINANCE_FAPI_BASE` and `BINANCE_BASE` are set to `https://fapi.binance.com` in `oi_poller.py`, `rest_pollers.py`, `ob_heatmap.py`, and `full_metrics_viewer.py`.

**CPU optimizations applied (see BACKEND_CLAUDE.md for details):**
- **OB reconstructor hard cap** (PR #53, #54): 2000 levels per side max, ±10% insert range. `_enforce_level_cap` batched per-side instead of per-insert. Prevents book bloat (previously grew to 40K+ levels).
- **HistoryFrame normalized price cache** (PR #52): Lazy `_norm_cache` on `HistoryFrame` dataclass. Cut `_normalize_price` from 70% → <0.5% of pre-build CPU.
- **Pre-built history responses** (commit d23e443): All 6 default-parameter history responses (3 symbols × 2 types) pre-built every 30s on `_refresh_loop` background thread. Cache key lookup for clients using default params.
- **Feed-on-emit OB accumulator** (PR #42): `OrderbookReconstructor.on_book_update` no longer fires callback on every diff. Accumulator's `check_emit()` pulls state only at 30-second boundaries.
- **Depth throttled to 500ms, book metrics to 5s, JSON serialization eliminated on depth path, tape log flushes batched every 10s/50 events.**

**OKX WebSocket keepalive:** OKX requires text-level `"ping"` messages. Connector sends text `"ping"` when idle >15s, with `ping_interval=None, ping_timeout=None` on the websockets library. Binance and Bybit use standard protocol pings.

**Data retention (in-memory buffers):**
- OI history: 24h @ 5s resolution per symbol (`deque(maxlen=17280)`)
- Liq events: 12,000 events per symbol deque
- Liq heatmap history: ~720 frames (12h @ 1 frame/min)
- OB heatmap history: ~1440 frames (12h @ 1 frame/30s) with binary persistence to `.bin` files

All buffers start empty on restart.

**Deployment:**
```bash
ssh root@api.tradenet.org
cd /opt/tradenet-backend
git pull
systemctl restart tradenet-backend

# Verify
curl http://localhost:8899/health
top -bn1 | grep python3
```

### aggr-server (served via proxy.tradenet.org)

**What it is:** Node.js application at `/opt/aggr-server`, based on [Tucsky/aggr-server](https://github.com/Tucsky/aggr-server), runs as `aggr-server` systemd service.

**Port:** 3001 (changed from 3000 to avoid Grafana conflict).

**Purpose:** Connects to trade WebSocket streams on Binance, Bybit, OKX, Hyperliquid simultaneously, aggregates trades into a unified stream, stores in InfluxDB, resamples into time-bucketed bars.

**Config:** `/opt/aggr-server/config.json` — pairs list, `api: true`, `collect: true`, `broadcast: true`, `aggr: true`, `autofetch: true`. See Tucsky fork docs for all options.

**Markets:**
- BTC: `BINANCE_FUTURES:btcusdt+BYBIT:BTCUSDT+OKX:BTC-USDT-SWAP+HYPERLIQUID:BTC`
- ETH: `BINANCE_FUTURES:ethusdt+BYBIT:ETHUSDT+OKX:ETH-USDT-SWAP+HYPERLIQUID:ETH`
- SOL: `BINANCE_FUTURES:solusdt+BYBIT:SOLUSDT+OKX:SOL-USDT-SWAP+HYPERLIQUID:SOL`

**WebSocket endpoint:** `wss://proxy.tradenet.org/aggr/ws` (proxied through nginx).

**Key endpoints** (served via nginx at `/aggr/*`):
- `GET /products` — active market pairs
- `GET /historical/{from}/{to}/{timeframe?}/{markets?}` — OHLCV bars per exchange per timeframe
- `GET /footprint/{symbol}/{from_ms}/{to_ms}/{timeframe_ms}` — pre-aggregated footprint with per-level volume and CVD (max 12h range)
- `GET /cvd/{symbol}` — rolling 24h CVD in USD across all 4 exchanges
- `GET /bar_stats/{symbol}?timeframe={ms}` — server-authoritative current candle vol/delta/CVD (60-entry 1-minute ring buffer, sum-on-read for any timeframe up to 60min)

**Data flow:** aggr-server ingests raw trades → InfluxDB `aggr_raw` retention → resampled into `aggr_10s`, `aggr_30s`, `aggr_1m`, `aggr_3m`, `aggr_5m`, `aggr_15m`, `aggr_30m`, `aggr_1h`, `aggr_2h`, `aggr_4h`, `aggr_6h`, `aggr_1d` retentions via periodic resample job (~every 60s).

**Known scaling concern:** Bar stats polling from frontend at 250ms per pane per timeframe is the dominant InfluxDB workload. When active users hit multiple panes on different timeframes, InfluxDB CPU scales from ~10% baseline to 90-120%. Planned mitigations: frontend request dedupe across panes, aggr-server TTL cache on `/bar_stats`.

### InfluxDB

**Version:** InfluxDB 1.x, running as `influxdb` systemd service.
**Port:** 8086 (local only, not exposed externally).
**Config:** `/etc/influxdb/influxdb.conf` — defaults. `cache-max-memory-size` currently commented out (default 1GB). Candidate for tuning to 4GB when scaling past current load.
**Data:** ~16GB written since aggr-server deploy (April 17). Cascading downsampling pipeline is the primary write load.
**Retention policies:** `aggr_raw` (tick-level, ~12h), then `aggr_10s`, `aggr_30s`, `aggr_1m`, ..., `aggr_1d`.

### nginx

**Config:** `/etc/nginx/sites-available/tradenet` (or similar). Two `server` blocks share the same Hetzner IP:

**`api.tradenet.org`** — reverse proxy to Python backend on port 8899:
```nginx
server {
    listen 443 ssl;
    server_name api.tradenet.org;
    ssl_certificate /etc/letsencrypt/live/api.tradenet.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.tradenet.org/privkey.pem;

    location / {
        proxy_pass http://localhost:8899;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
    }
}
```

**`proxy.tradenet.org`** — serves three distinct paths:

1. **Binance REST/WS passthroughs** — cached for rate-limit protection across users:
```nginx
location /spot/    { proxy_pass https://api.binance.com/; proxy_cache binance_cache; proxy_cache_valid 200 5s; }
location /futures/ { proxy_pass https://fapi.binance.com/; proxy_cache binance_cache; proxy_cache_valid 200 5s; }
location /inverse/ { proxy_pass https://dapi.binance.com/; proxy_cache binance_cache; proxy_cache_valid 200 5s; }
location /ws           { proxy_pass https://stream.binance.com/ws; /* WS upgrade headers */ }
location /ws-futures   { proxy_pass https://fstream.binance.com/ws; }
location /ws-inverse   { proxy_pass https://dstream.binance.com/ws; }
```

2. **aggr-server** — proxied to Node.js on port 3001:
```nginx
location /aggr/ {
    proxy_pass http://localhost:3001/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

3. **Velopack releases** — static file serving for desktop app auto-updates:
```nginx
location /releases/ {
    alias /var/www/releases/;
    autoindex on;
}
```

Updates are packed locally with `vpk pack` then `scp`'d to `/var/www/releases/`. The desktop app's embedded Velopack client polls `https://proxy.tradenet.org/releases/releases.win.json` on startup and offers updates in a modal.

**Firewall:** Hetzner Cloud Firewall (not OS ufw) allows TCP 80/443 inbound. OS-level ufw allows 22/tcp (SSH) and the above.

### Grafana + Prometheus

**Grafana:** Running on port 3000 on the same box. Dashboards track per-core CPU, disk I/O, node memory, WebSocket client counts, aggr-server API request rates, per-endpoint p50/p99 latency, per-symbol OB reconstructor levels, heatmap frame ages, Python backend RSS.

**Prometheus:** Scrapes `/metrics` endpoint on the Python backend (Prometheus text exposition format, added PR #46) plus `node_exporter` on port 9100 for system metrics. Metric cardinality is bounded by restricting API request path labels to a `_KNOWN_ROUTES` set.

Useful Grafana metrics:
- `tradenet_cpu_percent` — Python backend process CPU
- `tradenet_memory_rss_bytes` — Python backend RSS
- `tradenet_ob_levels{symbol=...}` — OB reconstructor level count per side (confirm stays near 2000)
- `tradenet_ws_clients_total` — active frontend WebSocket connections
- `tradenet_api_request_duration_seconds` with p50/p90/p99 quantiles per route

---

## Data Routing — Complete Reference

| Data Type | Single Exchange (e.g. BINANCE:BTCUSDT) | Aggregated (AGGREGATED:BTCUSDT) |
|-----------|----------------------------------------|--------------------------------|
| **Klines / OHLC** | proxy.tradenet.org → Binance REST/WS (cached 5s) | proxy.tradenet.org → aggr-server `/aggr/historical` (OHLCV from 4 exchanges). Falls back to Binance for dates before aggr-server started. |
| **Trade stream** (footprint, volume, delta) | proxy.tradenet.org → Binance aggTrade WS | `wss://proxy.tradenet.org/aggr/ws` — aggr-server (trades from ALL 4 exchanges) |
| **Footprint + per-candle bar stats** | Client-computed from trades | `/aggr/footprint/{symbol}/{from}/{to}/{tf}` — server-aggregated from 4 exchanges with per-level volumes and CVD |
| **Live bar stats (current candle)** | Client-accumulated from trades | `/aggr/bar_stats/{symbol}?timeframe={ms}` — polled every 250ms, server-authoritative vol/delta/CVD from 60-entry ring buffer |
| **24H CVD** | Client-computed sliding window | `/aggr/cvd/{symbol}` or `cvd_24h` field on `/aggr/footprint` — rolling 24h in USD across all 4 exchanges |
| **OI data** | proxy.tradenet.org → Binance OI REST | api.tradenet.org:8899 → `/oi` — Python backend aggregates Binance + Bybit + OKX (direct REST polling, 5s interval) |
| **OI history for backfill** | proxy.tradenet.org → Binance `/data/openInterestHist` | api.tradenet.org:8899 → `/oi_history?symbol=BTC&from={ms}&to={ms}` — 24h ring buffer |
| **Liq heatmap / zones** | api.tradenet.org:8899 → `/liq_heatmap_v2`, `/liq_zones` | Same endpoints, same forceOrder aggregation (all 3 exchanges via direct WS) |
| **Liq events** | api.tradenet.org:8899 → `/liq_events` | Same endpoint. Individual force orders with exchange field, ms timestamps, `since_ts` cursor pagination |
| **OB heatmap** | api.tradenet.org:8899 → Python backend (Binance depth via direct WS) | Same endpoint — currently Binance-only depth. Multi-exchange OB aggregation planned post-beta (Phase G). |
| **Market data** (mark, funding, OI combo) | api.tradenet.org:8899 → `/market_data` | Same endpoint |
| **Trader ratios** | api.tradenet.org:8899 → `/trader_ratios` | BTC only, Binance direct via Hetzner IP |

---

## Backend API Endpoints (port 8899)

All endpoints accept `?symbol=BTC` (or ETH, SOL). Default is BTC. Invalid symbols return 400. Transient warmup returns 503.

| Endpoint | Alias | Cache | Description |
|----------|-------|-------|-------------|
| `/health` | `/v1/health` | none | Server status, exchange connectivity, per-symbol buffer availability, uptime |
| `/metrics` | — | none | Prometheus text exposition format — process health, exchange status, OB level counts, endpoint latencies |
| `/oi` | — | 5s | Aggregated OI + per-exchange breakdown + delta fields. **No `/v2/oi` alias — use `/oi` directly.** |
| `/oi_history` | — | 5s | 24h OI ring buffer for AGGREGATED bar stats backfill. **No `/v2/` alias.** |
| `/market_data` | `/v2/market_data` | 5s | Mark price, last price, funding rate, OI in one call |
| `/trader_ratios` | `/v2/trader_ratios` | 5s | Top trader long/short ratios (BTC only) |
| `/liq_events` | `/v2/liq_events` | none | Individual force orders with exchange field, `since_ts` filtering |
| `/liq_heatmap_v2` | `/v2/liq_heatmap` | 5s | Live liq pools with source field (tape/inference/combined), u8 intensity grid |
| `/liq_heatmap_v2_history` | `/v2/liq_heatmap_history` | 30s | Historical liq intensity grid. Default params (`minutes=720, stride=1`) served from pre-built cache. |
| `/liq_stats` | `/v2/liq_stats` | 5s | Liq heatmap engine stats (tape events, inferences, bucket counts) |
| `/liq_zones` | `/v3/liq_zones` | 5s | Active prediction zones from ActiveZoneManager |
| `/liq_zones_summary` | `/v3/liq_zones_summary` | 5s | Zone summary statistics |
| `/liq_zones_heatmap` | `/v3/liq_heatmap` | 5s | Zone data formatted as heatmap levels |
| `/orderbook_heatmap` | `/v2/orderbook_heatmap_30s` | 5s (JSON) | Live OB frame. `format=bin` bypasses cache. |
| `/orderbook_heatmap_history` | `/v2/orderbook_heatmap_30s_history` | 30s (JSON) | Historical OB grid. Default params pre-built. `format=bin` available. |
| `/orderbook_heatmap_stats` | `/v2/orderbook_heatmap_30s_stats` | 10s | Per-symbol OB reconstructor diagnostics (level counts, sync status, last update) |

**V1 liq heatmap history is REMOVED.** `/liq_heatmap_history` returns 503. V1 binary files are deleted on startup. Use `/liq_heatmap_v2_history`.

**Response cache:** `ResponseCache` with LRU eviction (`MAX_CACHE_ENTRIES=500`). Keys normalized via `ResponseCache.normalize_cache_key()` — symbols uppercased, floats rounded to 2dp, side validated, keys >200 chars MD5-hashed. Prevents cardinality explosion.

---

## Emergency Migration Runbook (DO → Hetzner, April 22, 2026)

Binance IP-banned the DigitalOcean Frankfurt droplet (REST and WebSocket both dead). Resolved by migrating aggr-server + nginx to the Hetzner backend box. Steps preserved for reference:

1. Install Node.js 20, InfluxDB (direct `.deb`), nginx, certbot on Hetzner.
2. Add 2GB swap (`fallocate`, `mkswap`, `swapon`, `/etc/fstab` entry).
3. Clone aggr-server from GitHub, `npm install` + `npm install tx2` (missing dep).
4. Copy `config.json` and `.env` from DO, change port `3000 → 3001` (Grafana already on 3000).
5. Create systemd service `/etc/systemd/system/aggr-server.service`.
6. Replace nginx config with two `server` blocks (one for api.tradenet.org, one for proxy.tradenet.org containing Binance proxy locations + `/aggr/` + `/releases/`).
7. Update DNS A records for both domains → Hetzner IP. (Both now point to same IP.)
8. Add Hetzner Cloud Firewall rules for TCP 80/443 inbound.
9. Run certbot for SSL on both domains.
10. Verify clean Binance REST/WS connectivity from Hetzner IP.
11. Decommission DO droplet.

Backend was subsequently updated (PR #47) to call `fapi.binance.com` directly, since Hetzner IP was no longer Binance-banned.

---

## Scaling Notes

- **Current beta (3-5 testers):** CCX23 handles comfortably. CPU ~20-30% per core baseline, spikes to 60-80% during multi-user heatmap activity.
- **50 concurrent users:** Likely requires InfluxDB query reduction (frontend bar stats dedupe + aggr-server TTL cache) before hardware upgrade.
- **100+ concurrent users:** Upgrade to CCX33 ($50/mo, 8 vCPU, 32GB) or split services (aggr+InfluxDB on one box, backend on another).
- **Binance rate limits:** 300 WebSocket connections per 5min per IP. Not an issue until 300+ simultaneous users since streams are shared.
- **Backend CPU optimizations already applied:** OB cap, frame normalize cache, pre-built history, feed-on-emit accumulator. Remaining work: incremental pre-build loops (only new frames vs full 12h rebuild), subscriber-gated pre-builds, bar stats client-side dedupe + server cache.

---

## Operational Checks

```bash
# Python backend
systemctl status tradenet-backend
curl http://localhost:8899/health
curl http://localhost:8899/metrics | head -40

# aggr-server
systemctl status aggr-server
journalctl -u aggr-server --no-pager -n 20
# Should see "resampling X markets" roughly every minute

# InfluxDB
systemctl status influxdb
curl -s http://localhost:8086/health

# Combined CPU snapshot
top -b -n 1 | head -15

# Per-process CPU sampling over 60s
top -b -d 1 -n 60 | grep -E "python3|node|influxd" > /tmp/cpu.log
awk '/python3/ {py+=$9; pyc++} /node/ {n+=$9; nc++} /influxd/ {i+=$9; ic++} END {print "Python:", py/pyc"%"; print "Node:", n/nc"%"; print "InfluxDB:", i/ic"%"}' /tmp/cpu.log

# OB reconstructor health (confirm levels stay capped)
journalctl -u tradenet-backend --since '5 minutes ago' --no-pager | grep OB_RECON | tail -5

# py-spy profile (Python backend)
py-spy record --pid $(pgrep -f full_metrics_viewer.py | head -1) --duration 30 --rate 50 --format speedscope -o /tmp/profile.json
```

---

## Known Operational Quirks

1. **In-memory buffers start empty on restart.** OI history, liq events, bar stats ring, CVD accumulator. Frontend must handle empty/short responses gracefully.
2. **CVD 5-minute reconciliation** in aggr-server is a full re-seed rather than incremental — wastes InfluxDB cycles every 5 minutes. Candidate for a ~20-line fix (`reconcileCVD` to incremental update).
3. **InfluxDB cache size** is default (1GB). Candidate to uncomment `cache-max-memory-size = "4g"` when scaling.
4. **Aggr-server resample job** runs every ~60s across 12 markets × ~11 timeframes. Background load independent of clients. High-timeframe aggregations (1h+) rarely used live; could be computed on-demand.
5. **Pre-build loops in Python backend** (`_refresh_loop`, `_prebuild_ob_history`) run every 30s regardless of active subscribers. Candidate for subscriber-gating and incremental append instead of full rebuild.
