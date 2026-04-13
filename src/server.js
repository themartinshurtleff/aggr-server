const EventEmitter = require('events')
const fs = require('fs')
const WebSocket = require('ws')
const {
  getIp,
  getHms,
  formatAmount
} = require('./helper')
const express = require('express')
const cors = require('cors')
const path = require('path')
const rateLimit = require('express-rate-limit')
const bodyParser = require('body-parser')
const config = require('./config')
const alertService = require('./services/alert')
const socketService = require('./services/socket')
const {
  connections,
  registerConnection,
  registerIndexes,
  restoreConnections,
  recovering,
  updateConnectionStats,
  dumpConnections
} = require('./services/connections')

class Server extends EventEmitter {
  constructor(exchanges) {
    super()

    this.exchanges = exchanges || []
    this.storages = null
    this.globalUsage = {
      tick: 0,
      sum: 0,
      points: []
    }

    /**
     * raw trades ready to be persisted into storage next save
     * @type Trade[]
     */
    this.chunk = []

    this.BANNED_IPS = []

    /**
     * Per-symbol 1-minute bar stats ring buffer.
     * 60 entries per symbol = 1 hour of 1-minute buckets.
     * Fed in real-time by dispatchRawTrades, summed on read for any timeframe.
     *
     * barStats[symbol] = {
     *   ring: Array<{ts, vol_buy, vol_sell}>,  // 60 slots
     *   head: number,                           // current write index
     *   headTs: number,                         // floored 1m timestamp of head bucket
     * }
     */
    this.BAR_STATS_BUCKET_MS = 60000 // 1 minute per bucket
    this.BAR_STATS_RING_SIZE = 60    // 60 minutes of history
    this.barStats = {}
    for (const sym of ['BTC', 'ETH', 'SOL']) {
      const ring = new Array(this.BAR_STATS_RING_SIZE)
      for (let i = 0; i < this.BAR_STATS_RING_SIZE; i++) {
        ring[i] = { ts: 0, vol_buy: 0, vol_sell: 0 }
      }
      this.barStats[sym] = { ring, head: 0, headTs: 0 }
    }

    /**
     * Prometheus metrics state.
     * Counters are integers, gauges are read live from existing state where possible.
     * Per-endpoint duration arrays are bounded ring buffers (last 1000 requests).
     */
    this.startedAt = Date.now()
    this.metrics = {
      tradesTotal: { BTC: 0, ETH: 0, SOL: 0 },
      // Rolling 60-second trade counts per symbol — array of {ts, count} pairs
      tradesPerSecondBuckets: { BTC: [], ETH: [], SOL: [] },
      wsBroadcastsTotal: { BTC: 0, ETH: 0, SOL: 0 },
      apiRequestsTotal: {},   // { endpoint: count }
      apiRequestDurations: {} // { endpoint: number[] (last 1000 ms) }
    }

    if (config.collect) {
      console.log('\n[server] collect is enabled')
      console.log(`\tconnect to -> ${this.exchanges.map(a => a.id).join(', ')}`)

      this.handleExchangesEvents()

      restoreConnections().then(() => {
        this.connectExchanges()
      })

      // profile exchanges connections (keep alive)
      this._activityMonitoringInterval = setInterval(
        this.monitorExchangesActivity.bind(this, Date.now()),
        1000 * 60
      )
    }

    this.initStorages().then(() => {
      if (config.collect) {
        if (this.storages) {
          const delay = this.scheduleNextBackup()

          console.log(
            `[server] scheduling first save to ${this.storages.map(
              storage => storage.constructor.name
            )} in ${getHms(delay)}...`
          )
        }
      }

      if (config.api) {
        if (!config.port) {
          console.error(
            `\n[server] critical error occured\n\t-> setting a network port is mandatory for API (value is ${config.port})\n\n`
          )
          process.exit()
        }

        this.createHTTPServer()

        // monitor data requests
        this._usageMonitorInterval = setInterval(
          this.monitorUsage.bind(this),
          10000
        )
      }

      // update banned users
      this.listenBannedIps()
    })
  }

  initStorages() {
    if (!config.storage) {
      return Promise.resolve()
    }

    this.storages = []

    const promises = []

    for (let name of config.storage) {
      console.log(`[storage] using "${name}" storage solution`)

      if (
        config.api &&
        config.storage.length > 1 &&
        !config.storage.indexOf(name)
      ) {
        console.log(`[storage] Set "${name}" as primary storage for API`)
      }

      let storage = new (require(`./storage/${name}`))()

      if (typeof storage.connect === 'function') {
        promises.push(storage.connect())
      } else {
        promises.push(Promise.resolve())
      }

      this.storages.push(storage)
    }

    console.log('[storage] all storage ready')

    return Promise.all(promises)
  }

  backupTrades(exitBackup) {
    if (exitBackup) {
      clearTimeout(this.backupTimeout)
    } else if (!this.storages || !this.chunk.length) {
      this.scheduleNextBackup()
      return Promise.resolve()
    }

    const chunk = this.chunk
      .splice(0, this.chunk.length)
      .sort((a, b) => a.timestamp - b.timestamp)
    // console.log(`[server] saving ${chunk.length} trades to storages`)

    return Promise.all(
      this.storages.map(storage => {
        if (exitBackup) {
          console.debug(
            `[server/exit] saving ${chunk.length} trades into ${storage.constructor.name}`
          )
        }
        return storage
          .save(chunk, exitBackup)
          .then(() => {
            if (exitBackup) {
              console.debug(
                `[server/exit] performed backup of ${chunk.length} trades into ${storage.constructor.name}`
              )
            }
          })
          .catch(err => {
            console.error(`[storage/${storage.name}] saving failure`, err)
          })
      })
    )
      .then(() => {
        if (!exitBackup) {
          this.scheduleNextBackup()
        }
      })
      .catch(err => {
        console.error(
          '[server] something went wrong while backuping trades...',
          err
        )
      })
  }

  scheduleNextBackup() {
    if (!this.storages) {
      return
    }

    const now = new Date()
    let delay =
      Math.ceil(now / config.backupInterval) * config.backupInterval - now - 20

    if (delay < 1000) {
      delay += config.backupInterval
    }

    this.backupTimeout = setTimeout(this.backupTrades.bind(this), delay)

    return delay
  }

  handleExchangesEvents() {
    this.exchanges.forEach(exchange => {
      exchange.on('trades', this.dispatchRawTrades.bind(this))
      exchange.on('liquidations', this.dispatchRawTrades.bind(this))
      exchange.on('disconnected', (pair, apiId, apiLength) => {
        const id = exchange.id + ':' + pair

        let lastPing = ''

        if (connections[id].timestamp) {
          lastPing =
            ' (last ping ' +
            new Date(+connections[id].timestamp).toISOString() +
            ')'
        }

        console.log(
          `[connections] ${id}${lastPing} disconnected from ${apiId} (${apiLength} remaining)`
        )

        connections[id].apiId = null
      })

      exchange.on('connected', (pair, apiId, apiLength) => {
        const id = exchange.id + ':' + pair

        registerConnection(id, exchange.id, pair, apiLength)

        if (typeof exchange.getMissingTrades === 'function') {
          exchange.recoverSinceLastTrade(connections[id])
        }

        let lastPing = ''

        if (connections[id].timestamp) {
          lastPing =
            ' (last ping ' +
            new Date(+connections[id].timestamp).toISOString() +
            ', ' +
            connections[id].lastConnectionMissEstimate +
            ' estimated miss)'
        }

        console.log(
          `[connections] ${id}${lastPing} connected to ${apiId} (${apiLength} total)`
        )

        connections[id].apiId = apiId

        socketService.syncMarkets()
      })

      exchange.on('close', (apiId, pairs, event) => {
        const reason = event.reason || 'no reason'

        if (pairs.length) {
          console.error(
            `[${exchange.id}] api closed unexpectedly (${apiId}, ${event.code
            }, ${reason}) (was handling ${pairs.join(',')})`
          )

          setTimeout(() => {
            this.reconnectApis([apiId], reason)
          }, 1000)
        }
      })
    })
  }

  createHTTPServer() {
    const app = express()

    app.use(cors())

    // Metrics middleware — track request counts and durations per normalized endpoint.
    // Normalizes path to the route prefix (e.g. /footprint/BTC/1/2/3 -> /footprint)
    // to keep label cardinality bounded.
    app.use((req, res, next) => {
      const start = Date.now()
      const path = req.path || req.url.split('?')[0]
      const segments = path.split('/').filter(Boolean)
      const endpoint = segments.length ? '/' + segments[0] : '/'

      res.on('finish', () => {
        const duration = Date.now() - start
        this.metrics.apiRequestsTotal[endpoint] =
          (this.metrics.apiRequestsTotal[endpoint] || 0) + 1
        if (!this.metrics.apiRequestDurations[endpoint]) {
          this.metrics.apiRequestDurations[endpoint] = []
        }
        const arr = this.metrics.apiRequestDurations[endpoint]
        arr.push(duration)
        if (arr.length > 1000) arr.shift()
      })
      next()
    })

    if (config.enableRateLimit) {
      const limiter = rateLimit({
        windowMs: config.rateLimitTimeWindow,
        max: config.rateLimitMax,
        handler: function (req, res) {
          res.header('Access-Control-Allow-Origin', '*')
          return res.status(429).send({
            error: 'too many requests :v'
          })
        }
      })

      // otherwise user are all the same
      app.set('trust proxy', 1)

      // apply to all requests
      app.use(limiter)
    }

    // Prometheus metrics endpoint — registered BEFORE the origin check so
    // backend scrapes always succeed regardless of CORS config.
    app.get('/metrics', (req, res) => {
      res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      res.send(this.renderMetrics())
    })

    app.all('/*', (req, res, next) => {
      var user = req.headers['x-forwarded-for'] || req.connection.remoteAddress

      const origin =
        typeof req.headers['origin'] !== 'undefined'
          ? req.headers['origin'].toString()
          : 'undefined'

      if (
        typeof origin === 'undefined' ||
        (!new RegExp(config.origin).test(origin) &&
          config.whitelist.indexOf(user) === -1)
      ) {
        console.log(`[${user}/BLOCKED] socket origin mismatch "${origin}"`)
        return res.status(500).send('💀')
      } else if (this.BANNED_IPS.indexOf(user) !== -1) {
        console.debug(`[${user}/BANNED] at "${req.url}" (origin was ${origin})`)

        return res.status(500).send('💀')
      } else {
        next()
      }
    })

    app.get('/', function (req, res) {
      res.json({
        message: 'hi'
      })
    })

    if (alertService.enabled) {
      app.use(bodyParser.json())

      app.post('/alert', async (req, res) => {
        const user = getIp(req)
        const alert = req.body

        if (
          !alert ||
          !alert.endpoint ||
          !alert.keys ||
          typeof alert.market !== 'string' ||
          typeof alert.price !== 'number'
        ) {
          return res.status(400).json({
            error: 'invalid alert payload'
          })
        }

        alert.user = user
        try {
          const data = await alertService.toggleAlert(alert)
          res.status(201).json(data || {})
        } catch (error) {
          console.error(
            `[alert] couldn't toggle user alert because ${error.message}`
          )
          res.status(400).json({
            error: error.message
          })
        }
      })
    }

    app.get('/products', (req, res) => {
      let products = config.extraProducts

      if (socketService.clusteredCollectors.length) {
        // node is a cluster

        products = products.concat(
          socketService.clusteredCollectors
            .reduce(
              (acc, collectorSocket) => acc.concat(collectorSocket.markets),
              []
            )
            .filter((x, i, a) => a.indexOf(x) == i)
        )
      } else {
        products = products.concat(config.pairs)
      }

      res.json(products)
    })

    app.get(
      '/historical/:from/:to/:timeframe?/:markets([^/]*)?',
      (req, res) => {
        const user =
          req.headers['x-forwarded-for'] || req.connection.remoteAddress
        let from = parseInt(req.params.from)
        let to = parseInt(req.params.to)
        let length
        let timeframe = req.params.timeframe

        let markets = req.params.markets || []

        if (typeof markets === 'string') {
          markets = markets
            .split('+')
            .map(a => a.trim())
            .filter(a => a.length)
        }

        if (!config.api || !this.storages) {
          return res.status(501).json({
            error: 'no storage'
          })
        }

        const storage = this.storages.find(storage => storage.format === 'point')

        if (!storage) {
          return res.status(501).json({
            error: 'no compatible storage'
          })
        }

        if (isNaN(from) || isNaN(to)) {
          return res.status(400).json({
            error: 'missing interval'
          })
        }

        timeframe = parseInt(timeframe) || 1000 * 60 // default to 1m

        length = (to - from) / timeframe

        if (length > config.maxFetchLength) {
          return res.status(400).json({
            error: 'too many bars'
          })
        }

        if (from > to) {
          return res.status(400).json({
            error: 'from > to'
          })
        }

        this.globalUsage.tick += length * markets.length
        const fetchStartAt = Date.now()

          ; (storage
          ? storage.fetch({
            from,
            to,
            timeframe,
            markets
          })
          : Promise.resolve([])
        )
          .then(output => {
            if (!output) {
              return res.status(404).json({
                error: 'no results'
              })
            }

            if (output.results.length > 10000) {
              console.log(
                `[${user}/${req.get('origin')}] ${getHms(to - from)} (${markets.length
                } markets, ${getHms(timeframe, true)} tf) -> ${+length ? parseInt(length) + ' bars into ' : ''
                }${output.results.length} ${storage.format}s, took ${getHms(
                  Date.now() - fetchStartAt
                )}`
              )
            }

            return res.status(200).json(output)
          })
          .catch(err => {
            return res.status(500).json({
              error: err.message
            })
          })
      }
    )
    
    // Raw trades endpoint for aggregated footprint backfill
    app.get('/trades/:symbol/:from/:to', (req, res) => {
      const symbol = (req.params.symbol || '').toUpperCase()
      const from = parseInt(req.params.from)
      const to = parseInt(req.params.to)

      if (!['BTC', 'ETH', 'SOL'].includes(symbol)) {
        return res.status(400).json({
          error: 'invalid symbol, use BTC/ETH/SOL'
        })
      }

      if (isNaN(from) || isNaN(to) || from >= to) {
        return res.status(400).json({
          error: 'invalid time range'
        })
      }

      if (to - from > 12 * 60 * 60 * 1000) {
        return res.status(400).json({
          error: 'max range is 12 hours'
        })
      }

      if (!config.api || !this.storages) {
        return res.status(501).json({
          error: 'no storage'
        })
      }

      const storage = this.storages.find(
        storage => storage.format === 'point'
      )

      if (!storage || typeof storage.fetchRawTrades !== 'function') {
        return res.status(501).json({
          error: 'no compatible storage'
        })
      }

      storage
        .fetchRawTrades(symbol, from, to)
        .then(trades => {
          if (trades.length > 10000) {
            console.log(
              `[trades] ${symbol} ${from}-${to}: ${trades.length} raw trades`
            )
          }
          return res.status(200).json(trades)
        })
        .catch(err => {
          return res.status(500).json({
            error: err.message
          })
        })
    })

// Pre-aggregated footprint endpoint (OHLCV + volume-at-price levels)
    app.get('/footprint/:symbol/:from/:to/:timeframe', (req, res) => {
      const symbol = (req.params.symbol || '').toUpperCase()
      const from = parseInt(req.params.from)
      const to = parseInt(req.params.to)
      const timeframe = parseInt(req.params.timeframe)

      if (!['BTC', 'ETH', 'SOL'].includes(symbol)) {
        return res.status(400).json({
          error: 'invalid symbol, use BTC/ETH/SOL'
        })
      }

      if (isNaN(from) || isNaN(to) || from >= to) {
        return res.status(400).json({
          error: 'invalid time range'
        })
      }

      if (to - from > 12 * 60 * 60 * 1000) {
        return res.status(400).json({
          error: 'max range is 12 hours'
        })
      }

      if (isNaN(timeframe) || timeframe < 10000) {
        return res.status(400).json({
          error: 'invalid timeframe (min 10000ms)'
        })
      }

      // Default tick sizes per symbol, with optional override
      const DEFAULT_TICK_SIZES = { 'BTC': 5.0, 'ETH': 0.50, 'SOL': 0.05 }
      const tickSizeParam = parseFloat(req.query.tick_size)
      const tickSize = (!isNaN(tickSizeParam) && tickSizeParam > 0)
        ? tickSizeParam
        : DEFAULT_TICK_SIZES[symbol]

      if (!config.api || !this.storages) {
        return res.status(501).json({
          error: 'no storage'
        })
      }

      const storage = this.storages.find(
        storage => storage.format === 'point'
      )

      if (!storage || typeof storage.fetchFootprint !== 'function') {
        return res.status(501).json({
          error: 'no compatible storage'
        })
      }

      const fetchStartAt = Date.now()

      Promise.all([
        storage.fetchFootprint(symbol, from, to, timeframe, tickSize),
        typeof storage.fetchCVD24h === 'function'
          ? storage.fetchCVD24h(symbol).catch(() => null)
          : Promise.resolve(null)
      ])
        .then(([result, cvd]) => {
          const elapsed = Date.now() - fetchStartAt
          if (elapsed > 1000 || result.candles.length > 100) {
            const totalLevels = result.candles.reduce((sum, c) => sum + c.levels.length, 0)
            console.log(
              `[footprint] ${symbol} ${result.candles.length} candles, ${totalLevels} levels, ${elapsed}ms`
            )
          }
          if (cvd) {
            result.cvd_24h = cvd.cvd_24h
            result.cvd_24h_ts = cvd.cvd_24h_ts
          }
          return res.status(200).json(result)
        })
        .catch(err => {
          console.error('[footprint] error:', err.message || err)
          return res.status(500).json({
            error: err.message
          })
        })
    })

    // Lightweight CVD-only endpoint
    app.get('/cvd/:symbol', (req, res) => {
      const symbol = (req.params.symbol || '').toUpperCase()

      if (!['BTC', 'ETH', 'SOL'].includes(symbol)) {
        return res.status(400).json({
          error: 'invalid symbol, use BTC/ETH/SOL'
        })
      }

      if (!config.api || !this.storages) {
        return res.status(501).json({
          error: 'no storage'
        })
      }

      const storage = this.storages.find(
        storage => storage.format === 'point'
      )

      if (!storage || typeof storage.fetchCVD24h !== 'function') {
        return res.status(501).json({
          error: 'no compatible storage'
        })
      }

      storage
        .fetchCVD24h(symbol)
        .then(result => {
          return res.status(200).json({
            symbol,
            cvd_24h: result.cvd_24h,
            cvd_24h_ts: result.cvd_24h_ts
          })
        })
        .catch(err => {
          console.error('[cvd] error:', err.message || err)
          return res.status(500).json({
            error: err.message
          })
        })
    })

    // Live bar stats endpoint — server-authoritative current candle volume/delta
    app.get('/bar_stats/:symbol', (req, res) => {
      const symbol = (req.params.symbol || '').toUpperCase()

      if (!['BTC', 'ETH', 'SOL'].includes(symbol)) {
        return res.status(400).json({
          error: 'invalid symbol, use BTC/ETH/SOL'
        })
      }

      const timeframe = parseInt(req.query.timeframe) || 60000
      if (timeframe < 60000) {
        return res.status(400).json({
          error: 'minimum timeframe is 60000 (1 minute)'
        })
      }

      const bs = this.barStats[symbol]
      if (!bs || bs.headTs === 0) {
        return res.status(503).json({
          error: 'no data yet, warming up'
        })
      }

      // Compute the current candle's opening timestamp at the requested timeframe
      const now = Date.now()
      const candleTs = Math.floor(now / timeframe) * timeframe

      // Sum all 1-minute buckets that fall within this candle's window
      let volBuy = 0
      let volSell = 0
      const candleEnd = candleTs + timeframe

      for (let i = 0; i < this.BAR_STATS_RING_SIZE; i++) {
        const idx = ((bs.head - i) % this.BAR_STATS_RING_SIZE + this.BAR_STATS_RING_SIZE) % this.BAR_STATS_RING_SIZE
        const bucket = bs.ring[idx]
        if (bucket.ts === 0) continue
        if (bucket.ts < candleTs) break  // past the candle start, stop
        if (bucket.ts >= candleEnd) continue // shouldn't happen, but guard
        volBuy += bucket.vol_buy
        volSell += bucket.vol_sell
      }

      const response = {
        symbol,
        candle_ts: candleTs,
        timeframe,
        vol_buy: +volBuy.toFixed(2),
        vol_sell: +volSell.toFixed(2),
        delta: +(volBuy - volSell).toFixed(2)
      }

      // Include cvd_24h if storage supports it
      const storage = this.storages
        ? this.storages.find(s => s.format === 'point')
        : null

      if (storage && typeof storage.fetchCVD24h === 'function') {
        storage.fetchCVD24h(symbol)
          .then(cvd => {
            response.cvd_24h = cvd.cvd_24h
            response.cvd_24h_ts = cvd.cvd_24h_ts
            return res.status(200).json(response)
          })
          .catch(() => {
            return res.status(200).json(response)
          })
      } else {
        return res.status(200).json(response)
      }
    })

    app.use(function (err, req, res, _next) {
      if (err) {
        console.error(err)

        return res.status(500).json({
          error: 'internal server error 💀'
        })
      }
    })

    this.server = app.listen(config.port, () => {
      console.log(
        `[server] http server listening at localhost:${config.port}`,
        !config.api ? '(historical api is disabled)' : ''
      )
    })
    this.app = app

    // WebSocket broadcast server for live aggregated trades (BTC/ETH/SOL)
    this.wss = new WebSocket.Server({ server: this.server, path: '/ws' })
    this.wsClients = new Map() // ws -> Set<symbol>

    this.RAW_TRADE_MARKETS = {
      'BINANCE_FUTURES:btcusdt': 'BTC',
      'BYBIT:BTCUSDT': 'BTC',
      'OKEX:BTC-USDT-SWAP': 'BTC',
      'HYPERLIQUID:BTC': 'BTC',
      'BINANCE_FUTURES:ethusdt': 'ETH',
      'BYBIT:ETHUSDT': 'ETH',
      'OKEX:ETH-USDT-SWAP': 'ETH',
      'HYPERLIQUID:ETH': 'ETH',
      'BINANCE_FUTURES:solusdt': 'SOL',
      'BYBIT:SOLUSDT': 'SOL',
      'OKEX:SOL-USDT-SWAP': 'SOL',
      'HYPERLIQUID:SOL': 'SOL',
    }

    this.wss.on('connection', (ws) => {
      this.wsClients.set(ws, new Set())

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data)
          if (msg.subscribe) {
            const sym = msg.subscribe.toUpperCase()
            if (['BTC', 'ETH', 'SOL'].includes(sym)) {
              this.wsClients.get(ws).add(sym)
            }
          }
          if (msg.unsubscribe) {
            const sym = msg.unsubscribe.toUpperCase()
            this.wsClients.get(ws).delete(sym)
          }
        } catch (_e) {
          // ignore malformed messages
        }
      })

      ws.on('close', () => {
        this.wsClients.delete(ws)
      })

      ws.on('error', () => {
        this.wsClients.delete(ws)
      })
    })

    console.log(`[server] websocket broadcast available at ws://localhost:${config.port}/ws`)
  }

  /**
   * Render Prometheus text exposition format from current metrics state.
   * Format spec: https://prometheus.io/docs/instrumenting/exposition_formats/
   * @returns {string}
   */
  renderMetrics() {
    const lines = []
    const now = Date.now()
    const symbols = ['BTC', 'ETH', 'SOL']

    const escapeLabel = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

    const help = (name, text) => lines.push(`# HELP ${name} ${text}`)
    const type = (name, t) => lines.push(`# TYPE ${name} ${t}`)
    const metric = (name, value, labels) => {
      let labelStr = ''
      if (labels) {
        const parts = []
        for (const k in labels) {
          parts.push(`${k}="${escapeLabel(labels[k])}"`)
        }
        labelStr = '{' + parts.join(',') + '}'
      }
      // Format numbers — integers stay as integers, floats get full precision
      const v = Number.isFinite(value) ? value : 0
      lines.push(`${name}${labelStr} ${v}`)
    }

    // --- Process health ---
    help('aggr_uptime_seconds', 'Process uptime in seconds')
    type('aggr_uptime_seconds', 'gauge')
    metric('aggr_uptime_seconds', Math.floor((now - this.startedAt) / 1000))

    help('aggr_memory_rss_bytes', 'Resident set size of the Node.js process in bytes')
    type('aggr_memory_rss_bytes', 'gauge')
    metric('aggr_memory_rss_bytes', process.memoryUsage().rss)

    // --- Exchange connectivity ---
    help('aggr_exchange_connected', '1 if the exchange:pair has an active API connection, 0 otherwise')
    type('aggr_exchange_connected', 'gauge')
    help('aggr_exchange_last_message_age_seconds', 'Seconds since the last trade message was received on this exchange:pair')
    type('aggr_exchange_last_message_age_seconds', 'gauge')

    for (const id in connections) {
      const conn = connections[id]
      const labels = { exchange: conn.exchange, symbol: conn.pair }
      metric('aggr_exchange_connected', conn.apiId ? 1 : 0, labels)
      const ageSec = conn.timestamp ? Math.floor((now - conn.timestamp) / 1000) : -1
      metric('aggr_exchange_last_message_age_seconds', ageSec, labels)
    }

    // --- Trade throughput ---
    help('aggr_trades_total', 'Total number of trades received per symbol since process start')
    type('aggr_trades_total', 'counter')
    for (const sym of symbols) {
      metric('aggr_trades_total', this.metrics.tradesTotal[sym], { symbol: sym })
    }

    help('aggr_trades_per_second', 'Trades per second per symbol (rolling 60s average)')
    type('aggr_trades_per_second', 'gauge')
    const nowSec = Math.floor(now / 1000)
    const cutoff = nowSec - 60
    for (const sym of symbols) {
      const buckets = this.metrics.tradesPerSecondBuckets[sym]
      let sum = 0
      let span = 0
      for (const b of buckets) {
        if (b.ts < cutoff) continue
        sum += b.count
        span = Math.max(span, nowSec - b.ts + 1)
      }
      const rate = span > 0 ? sum / Math.min(span, 60) : 0
      metric('aggr_trades_per_second', +rate.toFixed(2), { symbol: sym })
    }

    // --- InfluxDB health ---
    help('aggr_influx_write_duration_ms', 'Duration of the most recent InfluxDB writePoints call in ms')
    type('aggr_influx_write_duration_ms', 'gauge')
    help('aggr_influx_resample_duration_ms', 'Duration of the most recent bar cascade resample in ms')
    type('aggr_influx_resample_duration_ms', 'gauge')

    const influxStorage = this.storages
      ? this.storages.find(s => s.format === 'point')
      : null

    if (influxStorage) {
      metric('aggr_influx_write_duration_ms', influxStorage.lastWriteDurationMs || 0)
      metric('aggr_influx_resample_duration_ms', influxStorage.lastResampleDurationMs || 0)
    } else {
      metric('aggr_influx_write_duration_ms', 0)
      metric('aggr_influx_resample_duration_ms', 0)
    }

    // --- Bar stats accumulator ---
    help('aggr_bar_stats_vol_buy', 'Current 1-minute candle vol_buy in USD')
    type('aggr_bar_stats_vol_buy', 'gauge')
    help('aggr_bar_stats_vol_sell', 'Current 1-minute candle vol_sell in USD')
    type('aggr_bar_stats_vol_sell', 'gauge')
    help('aggr_bar_stats_candle_ts', 'Current 1-minute candle opening timestamp in milliseconds')
    type('aggr_bar_stats_candle_ts', 'gauge')

    for (const sym of symbols) {
      const bs = this.barStats[sym]
      const headBucket = bs.ring[bs.head]
      metric('aggr_bar_stats_vol_buy', headBucket.vol_buy || 0, { symbol: sym })
      metric('aggr_bar_stats_vol_sell', headBucket.vol_sell || 0, { symbol: sym })
      metric('aggr_bar_stats_candle_ts', bs.headTs || 0, { symbol: sym })
    }

    // --- CVD ring buffer ---
    help('aggr_cvd_24h', 'Current rolling 24-hour cumulative volume delta in USD')
    type('aggr_cvd_24h', 'gauge')
    help('aggr_cvd_ring_entries', 'Number of non-zero entries in the CVD ring buffer (out of 8640)')
    type('aggr_cvd_ring_entries', 'gauge')

    if (influxStorage && influxStorage.cvdRing) {
      for (const sym of symbols) {
        const ring = influxStorage.cvdRing[sym]
        if (!ring) continue
        metric('aggr_cvd_24h', ring.seeded ? +ring.total.toFixed(2) : 0, { symbol: sym })
        let filled = 0
        for (let i = 0; i < ring.buckets.length; i++) {
          if (ring.buckets[i] !== 0) filled++
        }
        metric('aggr_cvd_ring_entries', filled, { symbol: sym })
      }
    }

    // --- WebSocket broadcast ---
    help('aggr_ws_clients_total', 'Number of currently connected WebSocket clients')
    type('aggr_ws_clients_total', 'gauge')
    metric('aggr_ws_clients_total', this.wsClients ? this.wsClients.size : 0)

    help('aggr_ws_broadcast_total', 'Total WebSocket broadcasts sent per symbol since process start')
    type('aggr_ws_broadcast_total', 'counter')
    for (const sym of symbols) {
      metric('aggr_ws_broadcast_total', this.metrics.wsBroadcastsTotal[sym], { symbol: sym })
    }

    // --- API request tracking ---
    help('aggr_api_requests_total', 'Total HTTP API requests received per endpoint')
    type('aggr_api_requests_total', 'counter')
    for (const endpoint in this.metrics.apiRequestsTotal) {
      metric('aggr_api_requests_total', this.metrics.apiRequestsTotal[endpoint], { endpoint })
    }

    help('aggr_api_request_duration_seconds', 'API request duration in seconds, p50/p90/p99 from last 1000 requests per endpoint')
    type('aggr_api_request_duration_seconds', 'summary')

    const quantile = (sortedMs, q) => {
      if (!sortedMs.length) return 0
      const idx = Math.min(sortedMs.length - 1, Math.floor(sortedMs.length * q))
      return sortedMs[idx] / 1000
    }

    for (const endpoint in this.metrics.apiRequestDurations) {
      const arr = this.metrics.apiRequestDurations[endpoint]
      if (!arr.length) continue
      const sorted = arr.slice().sort((a, b) => a - b)
      metric('aggr_api_request_duration_seconds', +quantile(sorted, 0.5).toFixed(6), { endpoint, quantile: '0.5' })
      metric('aggr_api_request_duration_seconds', +quantile(sorted, 0.9).toFixed(6), { endpoint, quantile: '0.9' })
      metric('aggr_api_request_duration_seconds', +quantile(sorted, 0.99).toFixed(6), { endpoint, quantile: '0.99' })
    }

    return lines.join('\n') + '\n'
  }

  monitorUsage() {
    const tick = this.globalUsage.tick
    this.globalUsage.points.push(tick)
    this.globalUsage.sum += tick
    this.globalUsage.tick = 0

    if (this.globalUsage.length > 90) {
      this.globalUsage.sum -= this.globalUsage.shift()
    }

    const avg = this.globalUsage.sum / this.globalUsage.points.length

    if (tick) {
      console.log(
        `[usage] ${formatAmount(tick)} points requested (${formatAmount(
          avg
        )} avg)`
      )
    }
  }

  connectExchanges() {
    if (!this.exchanges.length || !config.pairs.length) {
      return
    }

    this.chunk = []

    for (const exchange of this.exchanges) {
      const exchangePairs = config.pairs.filter(
        pair =>
          pair.indexOf(':') === -1 ||
          new RegExp('^' + exchange.id + ':').test(pair)
      )

      if (!exchangePairs.length) {
        continue
      }

      exchange.getProductsAndConnect(exchangePairs)
    }
  }

  async connect(markets) {
    markets = markets.filter(market => {
      if (config.pairs.indexOf(market) !== -1) {
        return false
      }

      return true
    })

    if (!markets.length) {
      throw new Error('nothing to connect')
    }

    const results = []

    for (const exchange of this.exchanges) {
      const exchangeMarkets = markets.filter(market => {
        const [exchangeId] = (market.match(/([^:]*):(.*)/) || []).slice(1, 3)

        return exchange.id === exchangeId
      })

      if (exchangeMarkets.length) {
        try {
          await exchange.getProducts(true)
        } catch (error) {
          console.error(
            `[server.connect] failed to retrieve ${exchange.id}'s products: ${error.message}`
          )
        }

        for (let market of exchangeMarkets) {
          try {
            await exchange.link(market)
            config.pairs.push(market)
            results.push(`${market} ✅`)
          } catch (error) {
            console.error(error.message)
            results.push(`${market} ❌ (${error.message})`)
          }
        }
      }
    }

    if (!results.length) {
      throw new Error('nothing was done')
    } else {
      registerIndexes()
      socketService.syncMarkets()

      this.savePairs()
    }

    return results
  }

  async disconnect(markets) {
    markets = markets.filter(market => {
      if (config.pairs.indexOf(market) === -1) {
        return false
      }

      return true
    })

    if (!markets.length) {
      throw new Error('nothing to disconnect')
    }

    const results = []

    for (let i = 0; i < markets.length; i++) {
      const market = markets[i]
      const marketIndex = config.pairs.indexOf(market)

      const [exchangeId] = market.match(/([^:]*):(.*)/).slice(1, 3)

      for (const exchange of this.exchanges) {
        if (exchange.id === exchangeId) {
          try {
            await exchange.unlink(market)
            config.pairs.splice(marketIndex, 1)
            results.push(`${market} ✅`)
          } catch (error) {
            console.error(error.message)
            results.push(`${market} ❌ (${error.message})`)
          }
          break
        }
      }
    }

    if (!results.length) {
      throw new Error('nothing was done')
    } else {
      registerIndexes()
      socketService.syncMarkets()

      this.savePairs()
    }

    return results
  }

  savePairs(isScheduled = false) {
    if (!isScheduled) {
      if (this._savePairsTimeout) {
        clearTimeout(this._savePairsTimeout)
      }

      this._savePairsTimeout = setTimeout(
        this.savePairs.bind(this, true),
        1000 * 60
      )

      return
    }

    if (!config.configPath) {
      console.warn(
        '[server] couldn\'t save config because configPath isn\'t known'
      )
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      fs.readFile(config.configPath, 'utf8', (err, rawConfig) => {
        if (err) {
          return reject(
            new Error(`failed to read config file (${err.message})`)
          )
        }

        const jsonConfig = JSON.parse(rawConfig)

        jsonConfig.pairs = config.pairs

        fs.writeFile(
          config.configPath,
          JSON.stringify(jsonConfig, null, '\t'),
          err => {
            if (err) {
              return reject(
                new Error(`failed to write config file (${err.message})`)
              )
            }

            console.log(`[server] saved active pairs in ${config.configPath}`)

            resolve()
          }
        )
      })
    })
  }

  reconnectApis(apiIds, reason) {
    for (let exchange of this.exchanges) {
      for (let api of exchange.apis) {
        const index = apiIds.indexOf(api.id)

        if (index !== -1) {
          exchange.reconnectApi(api, reason)

          apiIds.splice(index, 1)

          if (!apiIds.length) {
            break
          }
        }
      }
    }
  }

  listenBannedIps() {
    const file = path.resolve(__dirname, '../banned.txt')

    const watch = () => {
      fs.watchFile(file, () => {
        this.updateBannedIps()
      })
    }

    try {
      fs.accessSync(file, fs.constants.F_OK)

      this.updateBannedIps().then(success => {
        if (success) {
          watch()
        }
      })
    } catch (_error) {
      const _checkForWatchInterval = setInterval(() => {
        fs.access(file, fs.constants.F_OK, err => {
          if (err) {
            return
          }

          this.updateBannedIps().then(success => {
            if (success) {
              clearInterval(_checkForWatchInterval)

              watch()
            }
          })
        })
      }, 1000 * 10)
    }
  }

  updateBannedIps() {
    const file = path.resolve(__dirname, '../banned.txt')

    return new Promise(resolve => {
      fs.readFile(file, 'utf8', (err, data) => {
        if (err) {
          return
        }

        this.BANNED_IPS = data
          .split('\n')
          .map(a => a.trim())
          .filter(a => a.length)

        resolve(true)
      })
    })
  }

  /**
   * @param {Trade[]} trades
   */

  dispatchRawTrades(trades) {
    // Batch WS broadcasts per symbol
    const wsBatches = {}
    // Per-symbol trade counts for this batch (for metrics)
    const symbolTradeCounts = {}

    for (let i = 0; i < trades.length; i++) {
      const trade = trades[i]
      if (!trade.size) {
        continue
      }
      if (!trade.liquidation) {
        const identifier = trade.exchange + ':' + trade.pair
        // ping connection
        connections[identifier].hit++
        if (trade.timestamp > connections[identifier].timestamp) {
          connections[identifier].timestamp = trade.timestamp
        }

        // buffer for WS broadcast (BTC/ETH/SOL only, non-liquidation)
        const symbol = this.RAW_TRADE_MARKETS[identifier]
        if (symbol) {
          if (!wsBatches[symbol]) {
            wsBatches[symbol] = []
          }
          wsBatches[symbol].push([
            trade.timestamp,
            +trade.price,
            +trade.size,
            trade.side === 'buy' ? 0 : 1,
            trade.exchange
          ])
          symbolTradeCounts[symbol] = (symbolTradeCounts[symbol] || 0) + 1
        }
      }
      // save trade
      if (this.storages) {
        this.chunk.push(trade)
      }
    }

    // Update trade throughput metrics (per-symbol totals + rolling 60s buckets)
    const nowSec = Math.floor(Date.now() / 1000)
    for (const sym in symbolTradeCounts) {
      this.metrics.tradesTotal[sym] += symbolTradeCounts[sym]

      const buckets = this.metrics.tradesPerSecondBuckets[sym]
      const last = buckets[buckets.length - 1]
      if (last && last.ts === nowSec) {
        last.count += symbolTradeCounts[sym]
      } else {
        buckets.push({ ts: nowSec, count: symbolTradeCounts[sym] })
      }
      // Trim buckets older than 60 seconds
      const cutoff = nowSec - 60
      while (buckets.length && buckets[0].ts < cutoff) {
        buckets.shift()
      }
    }

    // Broadcast to subscribed WS clients
    if (this.wsClients && this.wsClients.size > 0) {
      const serialized = {}
      for (const [ws, symbols] of this.wsClients) {
        if (ws.readyState !== WebSocket.OPEN) continue
        for (const sym of symbols) {
          if (!wsBatches[sym] || !wsBatches[sym].length) continue
          if (!serialized[sym]) {
            serialized[sym] = JSON.stringify({ symbol: sym, trades: wsBatches[sym] })
          }
          try {
            ws.send(serialized[sym])
            this.metrics.wsBroadcastsTotal[sym]++
          } catch (_e) {
            // client gone, will be cleaned up on close
          }
        }
      }
    }

    // Accumulate into bar stats ring buffer (real-time, every trade)
    for (let i = 0; i < trades.length; i++) {
      const trade = trades[i]
      if (!trade.size || trade.liquidation) continue

      const identifier = trade.exchange + ':' + trade.pair
      const symbol = this.RAW_TRADE_MARKETS[identifier]
      if (!symbol) continue

      const bs = this.barStats[symbol]
      const tradeMinute = Math.floor(trade.timestamp / this.BAR_STATS_BUCKET_MS) * this.BAR_STATS_BUCKET_MS

      // Advance ring if we've moved to a new minute
      if (bs.headTs === 0) {
        bs.headTs = tradeMinute
        bs.ring[bs.head].ts = tradeMinute
      } else if (tradeMinute > bs.headTs) {
        const minutesToAdvance = Math.min(
          Math.floor((tradeMinute - bs.headTs) / this.BAR_STATS_BUCKET_MS),
          this.BAR_STATS_RING_SIZE
        )
        for (let j = 1; j <= minutesToAdvance; j++) {
          const idx = (bs.head + j) % this.BAR_STATS_RING_SIZE
          bs.ring[idx].ts = 0
          bs.ring[idx].vol_buy = 0
          bs.ring[idx].vol_sell = 0
        }
        bs.head = (bs.head + minutesToAdvance) % this.BAR_STATS_RING_SIZE
        bs.headTs = tradeMinute
        bs.ring[bs.head].ts = tradeMinute
      }

      // Find the correct bucket for this trade (may be slightly behind head)
      const minutesAgo = Math.floor((bs.headTs - tradeMinute) / this.BAR_STATS_BUCKET_MS)
      if (minutesAgo < 0 || minutesAgo >= this.BAR_STATS_RING_SIZE) continue

      const idx = ((bs.head - minutesAgo) % this.BAR_STATS_RING_SIZE + this.BAR_STATS_RING_SIZE) % this.BAR_STATS_RING_SIZE
      const usdVol = trade.price * trade.size
      if (trade.side === 'buy') {
        bs.ring[idx].vol_buy += usdVol
      } else {
        bs.ring[idx].vol_sell += usdVol
      }
    }
  }

  monitorExchangesActivity() {
    const now = Date.now()

    const staleConnections = []
    const apisToReconnect = []

    for (const id in connections) {
      if (!connections[id].apiId) {
        continue
      }

      updateConnectionStats(connections[id])

      if (
        now - connections[id].ping > connections[id].thrs &&
        apisToReconnect.indexOf(connections[id].apiId) === -1
      ) {
        // connection ping threshold reached
        staleConnections.push(connections[id])
        apisToReconnect.push(connections[id].apiId)
        continue
      }
    }

    if (apisToReconnect.length) {
      dumpConnections(staleConnections)
      this.reconnectApis(apisToReconnect, 'reconnection threshold reached')
    }
  }

  canExit() {
    let output = true

    for (const exchange of this.exchanges) {
      if (recovering[exchange.id]) {
        console.error(
          'Exchange is recovering trades, don\'t quit while it\'s doing its thing because all will be lost'
        )
        output = false
        break
      }
    }

    if (!output) {
      if (!this.exitAttempts) {
        this.exitAttempts = 0
      }
      this.exitAttempts++
      if (this.exitAttempts === 3) {
        console.error('[server] last warning.')
      } else if (this.exitAttempts === 4) {
        output = true
      }
    }

    return output
  }

  triggerAlert(user) {
    for (const market in alertService.alerts) {
      for (const range in alertService.alerts[market]) {
        for (const alert of alertService.alerts[market][range]) {
          if (
            alertService.alertEndpoints[alert.endpoint] &&
            alertService.alertEndpoints[alert.endpoint].user === user
          ) {
            alertService.queueAlert(alert, alert.market, Date.now())
            return `${alert.market} @${alert.price}`
          }
        }
      }
    }

    throw new Error(`alert not found for user ${user}`)
  }
}

module.exports = Server
