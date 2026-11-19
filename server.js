
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const API = "https://public.coindcx.com";
const ACTIVE_API =
  "https://api.coindcx.com/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=USDT";

const CONFIG = {
  scanInterval: 15000,
  candleLimit: 100,
  volumeMAPeriod: 20,
  flatLookback: 6,
  risingLookback: 3,
  flatTolerance: 0.003,
  minimumRise: 0.004,
  minimumVolumeRatio: 1.15,
  minimumQuoteVolume: 10000,
  minimumOrderbookDepth: 5000,
  maximumSpread: 0.002,
  atrMultiplierSL: 1.5,
  riskReward: 2,
  maxSignals: 20
};

const EXCLUDED = [
  "BTC", "ETH", "SOL", "BNB", "XRP",
  "DOGE", "ADA", "TRX", "LTC", "BCH",
  "DOT", "LINK", "AVAX", "TON"
];

let signals = [];
let scanStatus = {
  running: false,
  lastScan: null,
  scanned: 0,
  errors: 0,
  message: "Initializing scanner"
};

let scanning = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function number(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sma(values, period) {
  const result = [];

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }

    const slice = values.slice(i - period + 1, i + 1);
    result.push(
      slice.reduce((a, b) => a + b, 0) / period
    );
  }

  return result;
}

function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let ema = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    ));
  }

  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

function normalizeCandles(data) {
  if (!Array.isArray(data)) return [];

  return data.map(c => ({
    time: number(c.time ?? c.t ?? c[0]),
    open: number(c.open ?? c.o ?? c[1]),
    high: number(c.high ?? c.h ?? c[2]),
    low: number(c.low ?? c.l ?? c[3]),
    close: number(c.close ?? c.c ?? c[4]),
    volume: number(c.volume ?? c.v ?? c[5])
  })).filter(c =>
    c.open > 0 &&
    c.high > 0 &&
    c.low > 0 &&
    c.close > 0 &&
    c.volume >= 0
  ).sort((a, b) => a.time - b.time);
}

async function getJSON(url, params = {}) {
  const response = await axios.get(url, {
    params,
    timeout: 12000,
    headers: {
      "User-Agent": "Volume-Momentum-Scanner/1.0"
    }
  });

  return response.data;
}

async function getPairs() {
  const data = await getJSON(ACTIVE_API);

  if (!Array.isArray(data)) {
    throw new Error("Invalid CoinDCX instruments response");
  }

  return data.map(item => {
    if (typeof item === "string") return item;

    return item.pair ||
      item.symbol ||
      item.instrument_name ||
      item.market ||
      "";
  }).filter(Boolean).filter(pair => {
    const p = pair.toUpperCase();

    return (
      p.includes("USDT") &&
      !EXCLUDED.some(coin =>
        new RegExp(`(^|[-_/])${coin}([-_/]|$)`).test(p)
      )
    );
  });
}

function formatPair(pair) {
  let p = pair.toUpperCase();

  if (p.startsWith("B-")) return p;

  if (p.includes("_")) return "B-" + p;

  if (p.endsWith("USDT")) {
    return "B-" + p.slice(0, -4) + "_USDT";
  }

  return p;
}

async function getCandles(pair, interval) {
  const data = await getJSON(
    `${API}/market_data/candles`,
    {
      pair: formatPair(pair),
      interval,
      limit: CONFIG.candleLimit
    }
  );

  return normalizeCandles(data);
}

async function getOrderbook(pair) {
  return await getJSON(
    `${API}/market_data/orderbook`,
    { pair: formatPair(pair) }
  );
}

function analyzeTrend(candles) {
  if (candles.length < 55) {
    return "UNKNOWN";
  }

  const closes = candles.map(c => c.close);

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);

  const previous20 = calculateEMA(
    closes.slice(0, -3), 20
  );

  const price = closes[closes.length - 1];

  if (
    price > ema20 &&
    ema20 > ema50 &&
    ema20 > previous20
  ) return "BULLISH";

  if (
    price < ema20 &&
    ema20 < ema50 &&
    ema20 < previous20
  ) return "BEARISH";

  return "NEUTRAL";
}

// Detect flat volume MA followed by a fresh upward turn.
function detectVolumeExpansion(candles) {
  const volumes = candles.map(c => c.volume);
  const ma = sma(volumes, CONFIG.volumeMAPeriod);

  if (ma.length < 40) return null;

  const valid = ma.filter(v => v !== null);

  if (valid.length < 15) return null;

  const latest = valid[valid.length - 1];

  const rising = valid.slice(
    -CONFIG.risingLookback
  );

  const flat = valid.slice(
    -(CONFIG.risingLookback + CONFIG.flatLookback),
    -CONFIG.risingLookback
  );

  if (flat.length !== CONFIG.flatLookback) return null;

  const flatAverage =
    flat.reduce((a, b) => a + b, 0) / flat.length;

  const flatDeviation =
    Math.max(...flat) - Math.min(...flat);

  const flatPercent = flatDeviation / flatAverage;

  if (flatPercent > CONFIG.flatTolerance) {
    return null;
  }

  // The MA must turn upward, not remain flat.
  for (let i = 1; i < rising.length; i++) {
    if (rising[i] <= rising[i - 1]) return null;
  }

  const risePercent =
    (latest - rising[0]) / rising[0];

  if (risePercent < CONFIG.minimumRise) {
    return null;
  }

  const currentVolume = volumes[volumes.length - 1];
  const previousVolumes = volumes.slice(-21, -1);

  const averageVolume =
    previousVolumes.reduce((a, b) => a + b, 0) /
    previousVolumes.length;

  const volumeRatio =
    averageVolume > 0
      ? currentVolume / averageVolume
      : 0;

  if (volumeRatio < CONFIG.minimumVolumeRatio) {
    return null;
  }

  return {
    flatPercent,
    risePercent,
    volumeRatio,
    volumeMA: latest
  };
}

function checkOrderbook(book, price) {
  if (!book || !book.bids || !book.asks) {
    return { passed: false, reason: "Orderbook unavailable" };
  }

  function getLevels(side) {
    const raw = side[0] && Array.isArray(side[0])
      ? side[0]
      : side;

    return Object.entries(raw || {}).map(([p, q]) => ({
      price: number(p),
      quantity: number(q)
    })).filter(x => x.price > 0 && x.quantity > 0);
  }

  const bids = getLevels(book.bids);
  const asks = getLevels(book.asks);

  if (!bids.length || !asks.length) {
    return { passed: false, reason: "Empty orderbook" };
  }

  const bestBid = Math.max(...bids.map(x => x.price));
  const bestAsk = Math.min(...asks.map(x => x.price));

  const spread = (bestAsk - bestBid) / price;

  const bidDepth = bids
    .filter(x => x.price >= price * 0.99)
    .reduce((a, x) => a + x.price * x.quantity, 0);

  const askDepth = asks
    .filter(x => x.price <= price * 1.01)
    .reduce((a, x) => a + x.price * x.quantity, 0);

  if (spread <= 0 || spread > CONFIG.maximumSpread) {
    return { passed: false, reason: "Spread too high" };
  }

  if (
    bidDepth < CONFIG.minimumOrderbookDepth ||
    askDepth < CONFIG.minimumOrderbookDepth
  ) {
    return { passed: false, reason: "Insufficient depth" };
  }

  return {
    passed: true,
    spread,
    bidDepth,
    askDepth
  };
}

function checkLiquidityTrap(candles, direction) {
  const recent = candles.slice(-8);

  if (recent.length < 8) {
    return { passed: false, reason: "Insufficient history" };
  }

  const last = recent[recent.length - 1];

  const range = last.high - last.low;
  if (range <= 0) {
    return { passed: false, reason: "Invalid candle" };
  }

  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;

  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / range;

  // Reject extreme rejection candles.
  if (
    direction === "BUY" &&
    upperWick / range > 0.60
  ) {
    return { passed: false, reason: "Upper wick rejection" };
  }

  if (
    direction === "SELL" &&
    lowerWick / range > 0.60
  ) {
    return { passed: false, reason: "Lower wick rejection" };
  }

  if (bodyRatio < 0.15) {
    return { passed: false, reason: "Weak price follow-through" };
  }

  // Reject a sudden sweep beyond the recent range.
  const previous = recent.slice(0, -1);

  const priorHigh = Math.max(...previous.map(c => c.high));
  const priorLow = Math.min(...previous.map(c => c.low));

  if (
    direction === "BUY" &&
    last.high > priorHigh &&
    last.close < priorHigh
  ) {
    return { passed: false, reason: "Possible buy-side liquidity sweep" };
  }

  if (
    direction === "SELL" &&
    last.low < priorLow &&
    last.close > priorLow
  ) {
    return { passed: false, reason: "Possible sell-side liquidity sweep" };
  }

  return { passed: true };
}

function buildTrade(candles, direction) {
  const last = candles[candles.length - 1];
  const atr = calculateATR(candles);

  if (!atr || atr <= 0) return null;

  const entry = last.close;

  const slDistance = atr * CONFIG.atrMultiplierSL;

  const stopLoss = direction === "BUY"
    ? entry - slDistance
    : entry + slDistance;

  const target = direction === "BUY"
    ? entry + slDistance * CONFIG.riskReward
    : entry - slDistance * CONFIG.riskReward;

  return {
    entry: Number(entry.toFixed(8)),
    stopLoss: Number(stopLoss.toFixed(8)),
    target: Number(target.toFixed(8)),
    riskReward: CONFIG.riskReward
  };
}

async function analyzeCoin(pair) {
  try {
    const [c5, c15, c1h, book] = await Promise.all([
      getCandles(pair, "5m"),
      getCandles(pair, "15m"),
      getCandles(pair, "1h"),
      getOrderbook(pair)
    ]);

    if (
      c5.length < 50 ||
      c15.length < 55 ||
      c1h.length < 55
    ) return null;

    const price = c5[c5.length - 1].close;

    const volumeSignal = detectVolumeExpansion(c5);
    if (!volumeSignal) return null;

    const trend15 = analyzeTrend(c15);
    const trend1h = analyzeTrend(c1h);

    let direction;

    if (
      trend15 === "BULLISH" &&
      trend1h === "BULLISH"
    ) {
      direction = "BUY";
    } else if (
      trend15 === "BEARISH" &&
      trend1h === "BEARISH"
    ) {
      direction = "SELL";
    } else {
      return null;
    }

    const liquidity = checkOrderbook(book, price);

    if (!liquidity.passed) return null;

    const trap = checkLiquidityTrap(c5, direction);

    if (!trap.passed) return null;

    const trade = buildTrade(c5, direction);
    if (!trade) return null;

    const currentCandle = c5[c5.length - 1];

    const quoteVolume =
      currentCandle.close * currentCandle.volume;

    if (quoteVolume < CONFIG.minimumQuoteVolume) {
      return null;
    }

    return {
      coin: pair,
      direction,
      timeframe: "5m",
      trend15m: trend15,
      trend1h: trend1h,
      volumeMA: volumeSignal.volumeMA,
      volumeMARisePercent:
        Number((volumeSignal.risePercent * 100).toFixed(3)),
      volumeRatio:
        Number(volumeSignal.volumeRatio.toFixed(2)),
      spreadPercent:
        Number((liquidity.spread * 100).toFixed(3)),
      liquidityStatus: "PASSED",
      trapProtection: "PASSED",
      ...trade,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    scanStatus.errors++;
    return null;
  }
}

async function scanMarket() {
  if (scanning) return;

  scanning = true;
  scanStatus.running = true;
  scanStatus.message = "Scanning CoinDCX market";

  let scanned = 0;
  const found = [];

  try {
    const pairs = await getPairs();

    scanStatus.totalPairs = pairs.length;

    // Limit concurrent API requests to avoid rate limiting.
    const batchSize = 5;

    for (let i = 0; i < pairs.length; i += batchSize) {
      const batch = pairs.slice(i, i + batchSize);

      const results = await Promise.all(
        batch.map(pair => analyzeCoin(pair))
      );

      scanned += batch.length;

      for (const result of results) {
        if (result) found.push(result);
      }

      scanStatus.scanned = scanned;

      await sleep(300);
    }

    signals = found
      .sort((a, b) =>
        b.volumeMARisePercent - a.volumeMARisePercent
      )
      .slice(0, CONFIG.maxSignals);

    scanStatus.lastScan = new Date().toISOString();
    scanStatus.message = signals.length
      ? `${signals.length} confirmed signals found`
      : "NO TRADE - No setup passed all strict filters";

  } catch (error) {
    scanStatus.message = error.message;
    scanStatus.errors++;
  } finally {
    scanning = false;
    scanStatus.running = false;
  }
}

app.get("/api/status", (req, res) => {
  res.json(scanStatus);
});

app.get("/api/signals", (req, res) => {
  res.json({
    status: signals.length ? "SIGNALS_FOUND" : "NO_TRADE",
    count: signals.length,
    signals
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    online: true,
    scanner: "Volume Momentum Scanner",
    exchange: "CoinDCX",
    timeframe: "5m",
    analysis: ["15m", "1h"],
    timestamp: new Date().toISOString()
  });
});

app.get("/", (req, res) => {
  res.json({
    message: "Volume Momentum Scanner API is running",
    endpoints: [
      "/api/health",
      "/api/status",
      "/api/signals"
    ]
  });
});

app.listen(PORT, () => {
  console.log(`Scanner running on port ${PORT}`);

  scanMarket();

  setInterval(() => {
    scanMarket();
  }, CONFIG.scanInterval);
});
