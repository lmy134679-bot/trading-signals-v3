/**
 * Gate.io API 客户端 - 带智能缓存
 * 
 * 缓存策略：
 * - 1m K线：不缓存最后一根（未收盘），历史部分TTL 2s
 * - 5m K线：最后一根TTL 5s，历史部分TTL 30s
 * - 15m K线：最后一根TTL 10s，历史部分TTL 60s
 * - 1h K线：最后一根TTL 30s，历史部分TTL 120s
 * - 4h K线：最后一根TTL 60s，历史部分TTL 300s
 * - 1d K线：最后一根TTL 120s，历史部分TTL 600s
 */

const axios = require('axios');

const BASE_URL = 'https://api.gateio.ws/api/v4';

// 54个交易对
const SYMBOLS_54 = [
  'BTC_USDT', 'ETH_USDT', 'BNB_USDT', 'SOL_USDT', 'XRP_USDT',
  'DOGE_USDT', 'TRX_USDT', 'ADA_USDT', 'AVAX_USDT', 'LINK_USDT',
  'TON_USDT', 'SUI_USDT', 'DOT_USDT', 'XLM_USDT', 'SHIB_USDT',
  'LTC_USDT', 'BCH_USDT', 'UNI_USDT', 'APT_USDT', 'NEAR_USDT',
  'ICP_USDT', 'ETC_USDT', 'HBAR_USDT', 'VET_USDT', 'FIL_USDT',
  'ALGO_USDT', 'THETA_USDT', 'XTZ_USDT', 'AXS_USDT', 'SAND_USDT',
  'MANA_USDT', 'GALA_USDT', 'CHZ_USDT', 'ENJ_USDT', 'BAT_USDT',
  'ZIL_USDT', 'IOTA_USDT', 'EOS_USDT', 'NEO_USDT', 'QTUM_USDT',
  'ONT_USDT', 'ZRX_USDT', 'KNC_USDT', 'COMP_USDT', 'MKR_USDT',
  'YFI_USDT', 'AAVE_USDT', 'CRV_USDT', 'SNX_USDT', '1INCH_USDT',
  'SUSHI_USDT', 'LRC_USDT', 'DYDX_USDT', 'PEPE_USDT'
];

// 时间框架配置（毫秒）
const TIMEFRAME_MS = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000
};

// 缓存TTL配置（毫秒）- 最后一根（未收盘）vs 历史K线
const CACHE_TTL = {
  '1m': { last: 0, history: 2000 },      // 1m: 最后一根不缓存，历史2s
  '5m': { last: 5000, history: 30000 },   // 5m: 最后一根5s，历史30s
  '15m': { last: 10000, history: 60000 }, // 15m: 最后一根10s，历史60s
  '30m': { last: 15000, history: 90000 }, // 30m: 最后一根15s，历史90s
  '1h': { last: 30000, history: 120000 }, // 1h: 最后一根30s，历史120s
  '4h': { last: 60000, history: 300000 }, // 4h: 最后一根60s，历史300s
  '1d': { last: 120000, history: 600000 } // 1d: 最后一根120s，历史600s
};

// K线缓存: { symbol_interval: { klines, timestamp, isLastBarClosed } }
const klinesCache = new Map();

// 价格缓存
const priceCache = {
  data: null,
  timestamp: 0,
  ttl: 5000 // 价格TTL 5s
};

/**
 * 获取当前bar的起始时间戳
 */
function getCurrentBarStartTime(interval) {
  const timeframeMs = TIMEFRAME_MS[interval] || TIMEFRAME_MS['4h'];
  const now = Date.now();
  return Math.floor(now / timeframeMs) * timeframeMs;
}

/**
 * 检查K线是否已收盘
 */
function isBarClosed(klineTime, interval) {
  const timeframeMs = TIMEFRAME_MS[interval] || TIMEFRAME_MS['4h'];
  const currentBarStart = getCurrentBarStartTime(interval);
  // K线时间小于当前bar起始时间，说明已收盘
  return klineTime < currentBarStart;
}

/**
 * 获取缓存key
 */
function getCacheKey(symbol, interval) {
  return `${symbol}_${interval}`;
}

/**
 * 获取K线数据（带智能缓存）
 */
async function getKlines(symbol, interval = '4h', limit = 100) {
  const cacheKey = getCacheKey(symbol, interval);
  const cached = klinesCache.get(cacheKey);
  const ttlConfig = CACHE_TTL[interval] || CACHE_TTL['4h'];

  // 检查缓存是否有效
  if (cached && cached.klines && cached.klines.length > 0) {
    const lastKline = cached.klines[cached.klines.length - 1];
    const isLastClosed = isBarClosed(lastKline.time, interval);
    const age = Date.now() - cached.timestamp;

    // 根据最后一根K线是否收盘决定使用哪个TTL
    const effectiveTtl = isLastClosed ? ttlConfig.history : ttlConfig.last;

    // 如果缓存有效（在TTL内）
    if (age < effectiveTtl) {
      console.log(`[Cache] Hit for ${symbol} ${interval}, age: ${age}ms, lastBarClosed: ${isLastClosed}`);
      return cached.klines;
    }

    console.log(`[Cache] Expired for ${symbol} ${interval}, age: ${age}ms, ttl: ${effectiveTtl}ms`);
  }

  // 从API获取
  try {
    const currencyPair = symbol.replace('_', '_');
    const response = await axios.get(`${BASE_URL}/spot/candlesticks`, {
      params: {
        currency_pair: currencyPair,
        interval,
        limit
      },
      timeout: 10000
    });

    const klines = response.data.map(candle => ({
      time: parseInt(candle[0]) * 1000,
      volume: parseFloat(candle[1]),
      close: parseFloat(candle[2]),
      high: parseFloat(candle[3]),
      low: parseFloat(candle[4]),
      open: parseFloat(candle[5])
    }));

    // 按时间升序排序
    klines.sort((a, b) => a.time - b.time);

    // 更新缓存
    if (klines.length > 0) {
      const lastKline = klines[klines.length - 1];
      const isLastClosed = isBarClosed(lastKline.time, interval);

      klinesCache.set(cacheKey, {
        klines,
        timestamp: Date.now(),
        isLastBarClosed: isLastClosed
      });

      console.log(`[Cache] Updated ${symbol} ${interval}, bars: ${klines.length}, lastBarClosed: ${isLastClosed}`);
    }

    return klines;
  } catch (error) {
    console.error(`[Gate.io] Error fetching klines for ${symbol}:`, error.message);
    // 如果API失败但有缓存，返回缓存数据（即使过期）
    if (cached && cached.klines) {
      console.log(`[Cache] Returning stale data for ${symbol} ${interval}`);
      return cached.klines;
    }
    return null;
  }
}

/**
 * 获取所有交易对的K线数据（带智能缓存）
 */
async function getAllKlines(interval = '4h', limit = 100) {
  const results = {};

  // 并发获取所有交易对
  const promises = SYMBOLS_54.map(async (symbol) => {
    try {
      const klines = await getKlines(symbol, interval, limit);
      if (klines && klines.length > 0) {
        return { symbol, klines };
      }
    } catch (error) {
      console.error(`[Gate.io] Error for ${symbol}:`, error.message);
    }
    return null;
  });

  const settled = await Promise.allSettled(promises);

  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value) {
      results[result.value.symbol] = result.value.klines;
    }
  }

  console.log(`[Gate.io] Fetched klines for ${Object.keys(results).length} symbols (${interval})`);
  return results;
}

/**
 * 获取实时价格（带缓存）
 */
async function getTickers() {
  const now = Date.now();

  // 检查缓存
  if (priceCache.data && (now - priceCache.timestamp) < priceCache.ttl) {
    console.log(`[Cache] Price cache hit, age: ${now - priceCache.timestamp}ms`);
    return priceCache.data;
  }

  try {
    const response = await axios.get(`${BASE_URL}/spot/tickers`, {
      timeout: 10000
    });

    const tickers = {};
    for (const ticker of response.data) {
      const symbol = ticker.currency_pair;
      if (SYMBOLS_54.includes(symbol)) {
        tickers[symbol] = {
          last: parseFloat(ticker.last),
          high_24h: parseFloat(ticker.high_24h),
          low_24h: parseFloat(ticker.low_24h),
          change_percentage: parseFloat(ticker.change_percentage),
          base_volume: parseFloat(ticker.base_volume),
          quote_volume: parseFloat(ticker.quote_volume),
          // 添加标记价格（如果可用）
          mark_price: parseFloat(ticker.last) // Gate.io spot没有mark price，用last代替
        };
      }
    }

    // 更新缓存
    priceCache.data = tickers;
    priceCache.timestamp = now;

    console.log(`[Cache] Price cache updated, ${Object.keys(tickers).length} symbols`);
    return tickers;
  } catch (error) {
    console.error('[Gate.io] Error fetching tickers:', error.message);
    // 如果API失败但有缓存，返回缓存数据
    if (priceCache.data) {
      console.log('[Cache] Returning stale price data');
      return priceCache.data;
    }
    return {};
  }
}

/**
 * 获取单个交易对价格
 */
async function getTicker(symbol) {
  const tickers = await getTickers();
  return tickers[symbol] || null;
}

/**
 * 获取缓存统计信息
 */
function getCacheStats() {
  const stats = {
    klinesCacheSize: klinesCache.size,
    priceCacheAge: priceCache.data ? Date.now() - priceCache.timestamp : null,
    klinesDetails: []
  };

  for (const [key, value] of klinesCache.entries()) {
    const [symbol, interval] = key.split('_');
    const lastKline = value.klines[value.klines.length - 1];
    stats.klinesDetails.push({
      key,
      bars: value.klines.length,
      age: Date.now() - value.timestamp,
      isLastBarClosed: value.isLastBarClosed,
      lastClose: lastKline?.close
    });
  }

  return stats;
}

/**
 * 清除缓存
 */
function clearCache() {
  klinesCache.clear();
  priceCache.data = null;
  priceCache.timestamp = 0;
  console.log('[Cache] All caches cleared');
}

module.exports = {
  SYMBOLS_54,
  TIMEFRAME_MS,
  CACHE_TTL,
  getKlines,
  getAllKlines,
  getTickers,
  getTicker,
  getCacheStats,
  clearCache,
  getCurrentBarStartTime,
  isBarClosed
};
