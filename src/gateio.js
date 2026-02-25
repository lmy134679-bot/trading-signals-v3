/**
 * Gate.io API 客户端
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

/**
 * 获取K线数据
 */
async function getKlines(symbol, interval = '4h', limit = 100) {
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
    
    return response.data.map(candle => ({
      time: parseInt(candle[0]) * 1000,
      volume: parseFloat(candle[1]),
      close: parseFloat(candle[2]),
      high: parseFloat(candle[3]),
      low: parseFloat(candle[4]),
      open: parseFloat(candle[5])
    }));
  } catch (error) {
    console.error(`[Gate.io] Error fetching klines for ${symbol}:`, error.message);
    return null;
  }
}

/**
 * 获取所有交易对的K线数据
 */
async function getAllKlines(interval = '4h', limit = 100) {
  const results = {};
  
  for (const symbol of SYMBOLS_54) {
    try {
      const klines = await getKlines(symbol, interval, limit);
      if (klines && klines.length > 0) {
        results[symbol] = klines;
      }
    } catch (error) {
      console.error(`[Gate.io] Error for ${symbol}:`, error.message);
    }
  }
  
  console.log(`[Gate.io] Fetched klines for ${Object.keys(results).length} symbols`);
  return results;
}

/**
 * 获取实时价格
 */
async function getTickers() {
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
          quote_volume: parseFloat(ticker.quote_volume)
        };
      }
    }
    
    return tickers;
  } catch (error) {
    console.error('[Gate.io] Error fetching tickers:', error.message);
    return {};
  }
}

module.exports = {
  SYMBOLS_54,
  getKlines,
  getAllKlines,
  getTickers
};
