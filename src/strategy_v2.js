/**
 * 交易策略 V2.0
 * 
 * 基于SMC/ICT策略的信号生成
 */

const { SYMBOLS_54 } = require('./gateio');

// 策略配置
const CONFIG = {
  MIN_KLINES: 50,
  ATR_PERIOD: 14,
  SWING_LOOKBACK: 5,
  MIN_RRR: 2.0,
  MAX_RISK_PERCENT: 2.0
};

/**
 * 计算ATR
 */
function calculateATR(klines, period = 14) {
  if (klines.length < period + 1) return 0;
  
  const trValues = [];
  for (let i = 1; i < klines.length; i++) {
    const current = klines[i];
    const prev = klines[i - 1];
    
    const tr1 = current.high - current.low;
    const tr2 = Math.abs(current.high - prev.close);
    const tr3 = Math.abs(current.low - prev.close);
    
    trValues.push(Math.max(tr1, tr2, tr3));
  }
  
  const recentTR = trValues.slice(-period);
  return recentTR.reduce((a, b) => a + b, 0) / period;
}

/**
 * 计算MA
 */
function calculateMA(klines, period) {
  if (klines.length < period) return null;
  const sum = klines.slice(-period).reduce((s, k) => s + k.close, 0);
  return sum / period;
}

/**
 * 计算RSI
 */
function calculateRSI(klines, period = 14) {
  if (klines.length < period + 1) return 50;
  
  let gains = 0;
  let losses = 0;
  
  for (let i = klines.length - period; i < klines.length; i++) {
    const change = klines[i].close - klines[i - 1].close;
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * 检测摆动点
 */
function findSwingPoints(klines, lookback = 5) {
  const swingHighs = [];
  const swingLows = [];
  
  for (let i = lookback; i < klines.length - lookback; i++) {
    const current = klines[i];
    
    // 检测摆动高点
    let isSwingHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (klines[i - j].high >= current.high || klines[i + j].high >= current.high) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) {
      swingHighs.push({ index: i, price: current.high });
    }
    
    // 检测摆动低点
    let isSwingLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (klines[i - j].low <= current.low || klines[i + j].low <= current.low) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) {
      swingLows.push({ index: i, price: current.low });
    }
  }
  
  return { swingHighs, swingLows };
}

/**
 * 检测FVG
 */
function detectFVG(klines) {
  const fvgList = [];
  
  for (let i = 2; i < klines.length; i++) {
    const k1 = klines[i - 2];
    const k2 = klines[i - 1];
    const k3 = klines[i];
    
    // 看涨FVG
    if (k1.high < k3.low) {
      fvgList.push({
        type: 'BULLISH_FVG',
        top: k3.low,
        bottom: k1.high,
        timestamp: k3.time
      });
    }
    
    // 看跌FVG
    if (k1.low > k3.high) {
      fvgList.push({
        type: 'BEARISH_FVG',
        top: k1.low,
        bottom: k3.high,
        timestamp: k3.time
      });
    }
  }
  
  return fvgList;
}

/**
 * 生成信号
 */
function generateSignal(symbol, klines, ticker) {
  const currentPrice = ticker?.last || klines[klines.length - 1].close;
  const atr = calculateATR(klines);
  const ma20 = calculateMA(klines, 20);
  const ma50 = calculateMA(klines, 50);
  const rsi = calculateRSI(klines);
  
  const { swingHighs, swingLows } = findSwingPoints(klines);
  const fvgList = detectFVG(klines);
  
  // 确定方向
  let direction = 'LONG';
  let confidence = 50;
  
  if (ma20 && ma50) {
    if (ma20 > ma50 && rsi > 50) {
      direction = 'LONG';
      confidence = 60 + (rsi - 50) * 0.5;
    } else if (ma20 < ma50 && rsi < 50) {
      direction = 'SHORT';
      confidence = 60 + (50 - rsi) * 0.5;
    }
  }
  
  // 计算入场/止损/止盈
  let entryPrice, stopLoss, tp1, tp2;
  
  if (direction === 'LONG') {
    entryPrice = currentPrice;
    stopLoss = currentPrice - atr * 1.5;
    const risk = entryPrice - stopLoss;
    tp1 = entryPrice + risk * 2;
    tp2 = entryPrice + risk * 3;
  } else {
    entryPrice = currentPrice;
    stopLoss = currentPrice + atr * 1.5;
    const risk = stopLoss - entryPrice;
    tp1 = entryPrice - risk * 2;
    tp2 = entryPrice - risk * 3;
  }
  
  const rrr = 2.0;
  
  // 确定评级
  let rating = 'C';
  if (confidence >= 85) rating = 'S';
  else if (confidence >= 70) rating = 'A';
  else if (confidence >= 55) rating = 'B';
  
  return {
    id: `${symbol}_${Date.now()}`,
    symbol,
    direction,
    entry_price: entryPrice,
    current_price: currentPrice,
    sl: stopLoss,
    tp1,
    tp2,
    rrr,
    rating,
    score: Math.round(confidence),
    signal_type: 'TRADABLE',
    status: 'ACTIVE',
    timestamp: new Date().toISOString(),
    timeframe: '4H',
    data_source: 'Gate.io API',
    structure: {
      fvg: fvgList.slice(-2),
      swing_highs: swingHighs.slice(-3),
      swing_lows: swingLows.slice(-3)
    }
  };
}

/**
 * 扫描所有交易对
 */
async function scanAllSymbolsV2(klinesData, tickers) {
  const signals = [];
  const filtered = [];
  
  for (const symbol of SYMBOLS_54) {
    const klines = klinesData[symbol];
    const ticker = tickers[symbol];
    
    if (!klines || klines.length < CONFIG.MIN_KLINES) {
      filtered.push({ symbol, reason: 'INSUFFICIENT_DATA' });
      continue;
    }
    
    if (!ticker) {
      filtered.push({ symbol, reason: 'NO_TICKER_DATA' });
      continue;
    }
    
    try {
      const signal = generateSignal(symbol, klines, ticker);
      signals.push(signal);
    } catch (error) {
      filtered.push({ symbol, reason: 'GENERATION_ERROR', error: error.message });
    }
  }
  
  // 按评分排序
  signals.sort((a, b) => b.score - a.score);
  
  return {
    scan_time: new Date().toISOString(),
    total_signals: signals.length,
    signals,
    filtered,
    data_health: {
      status: 'HEALTHY',
      kline_count: Object.keys(klinesData).length,
      ticker_count: Object.keys(tickers).length
    }
  };
}

module.exports = {
  CONFIG,
  scanAllSymbolsV2,
  calculateATR,
  calculateMA,
  calculateRSI
};
