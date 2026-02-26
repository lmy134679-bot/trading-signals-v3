/**
 * 交易策略 V2.1 - SMC/ICT入场价格优化
 * 
 * 入场价格基于技术位而非实时价格：
 * 1. FVG边缘回测
 * 2. 订单块(Order Block)位置
 * 3. 结构突破后的回撤
 */

const { SYMBOLS_54 } = require('./gateio');

// 策略配置
const CONFIG = {
  MIN_KLINES: 50,
  ATR_PERIOD: 14,
  SWING_LOOKBACK: 5,
  MIN_RRR: 2.0,
  MAX_RISK_PERCENT: 2.0,
  // FVG入场配置
  FVG_ENTRY_RATIO: 0.5,      // FVG中轴线位置入场
  // 订单块配置
  OB_ENTRY_OFFSET: 0.002,    // 订单块边缘偏移(0.2%)
  // 结构突破回撤
  BOS_PULLBACK_RATIO: 0.382  // 斐波那契回撤38.2%
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
      swingHighs.push({ index: i, price: current.high, time: current.time });
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
      swingLows.push({ index: i, price: current.low, time: current.time });
    }
  }

  return { swingHighs, swingLows };
}

/**
 * 检测FVG (Fair Value Gap)
 */
function detectFVG(klines) {
  const fvgList = [];

  for (let i = 2; i < klines.length; i++) {
    const k1 = klines[i - 2];
    const k2 = klines[i - 1];
    const k3 = klines[i];

    // 看涨FVG: k1.high < k3.low
    if (k1.high < k3.low) {
      fvgList.push({
        type: 'BULLISH',
        top: k3.low,
        bottom: k1.high,
        mid: (k3.low + k1.high) / 2,
        timestamp: k3.time,
        index: i
      });
    }

    // 看跌FVG: k1.low > k3.high
    if (k1.low > k3.high) {
      fvgList.push({
        type: 'BEARISH',
        top: k1.low,
        bottom: k3.high,
        mid: (k1.low + k3.high) / 2,
        timestamp: k3.time,
        index: i
      });
    }
  }

  return fvgList;
}

/**
 * 检测订单块(Order Block)
 */
function detectOrderBlocks(klines) {
  const obs = [];

  for (let i = 3; i < klines.length - 1; i++) {
    const k0 = klines[i - 3];
    const k1 = klines[i - 2];
    const k2 = klines[i - 1];
    const k3 = klines[i];

    // 看涨订单块: 下跌趋势中最后一根看跌K线
    // 特征: k0,k1下跌, k2继续跌但可能是最后一跌, k3大涨
    if (k1.close < k1.open && k2.close < k2.open && k3.close > k3.open && 
        k3.close > k2.high && k2.low < k1.low) {
      obs.push({
        type: 'BULLISH',
        high: k2.high,
        low: k2.low,
        open: k2.open,
        close: k2.close,
        timestamp: k2.time,
        index: i - 1
      });
    }

    // 看跌订单块: 上涨趋势中最后一根看涨K线
    // 特征: k0,k1上涨, k2继续涨但可能是最后一涨, k3大跌
    if (k1.close > k1.open && k2.close > k2.open && k3.close < k3.open && 
        k3.close < k2.low && k2.high > k1.high) {
      obs.push({
        type: 'BEARISH',
        high: k2.high,
        low: k2.low,
        open: k2.open,
        close: k2.close,
        timestamp: k2.time,
        index: i - 1
      });
    }
  }

  return obs;
}

/**
 * 检测结构突破(BOS - Break of Structure)
 */
function detectBOS(klines, swingPoints) {
  const bosList = [];
  const { swingHighs, swingLows } = swingPoints;

  if (swingHighs.length < 2 || swingLows.length < 2) return bosList;

  const lastKline = klines[klines.length - 1];
  const prevKline = klines[klines.length - 2];

  // 看涨BOS: 价格突破前高
  const lastSwingHigh = swingHighs[swingHighs.length - 1];
  const prevSwingHigh = swingHighs[swingHighs.length - 2];

  if (lastKline.close > prevSwingHigh.price && prevKline.close <= prevSwingHigh.price) {
    bosList.push({
      type: 'BULLISH',
      level: prevSwingHigh.price,
      timestamp: lastKline.time,
      confirmed: lastKline.close > lastKline.open  // 阳线确认
    });
  }

  // 看跌BOS: 价格突破前低
  const lastSwingLow = swingLows[swingLows.length - 1];
  const prevSwingLow = swingLows[swingLows.length - 2];

  if (lastKline.close < prevSwingLow.price && prevKline.close >= prevSwingLow.price) {
    bosList.push({
      type: 'BEARISH',
      level: prevSwingLow.price,
      timestamp: lastKline.time,
      confirmed: lastKline.close < lastKline.open  // 阴线确认
    });
  }

  return bosList;
}

/**
 * 计算SMC入场价格
 * 
 * 优先级:
 * 1. FVG中轴线入场 (最优先)
 * 2. 订单块边缘入场
 * 3. 结构突破后回撤入场
 * 4. 摆动点支撑/阻力位入场
 */
function calculateSMCEntryPrice(direction, klines, fvgList, obList, swingPoints, currentPrice) {
  const atr = calculateATR(klines);
  const MAX_ENTRY_DISTANCE = 0.015; // 最大入场距离1.5%

  // 1. 寻找匹配的FVG
  const relevantFVGs = fvgList.filter(fvg => 
    (direction === 'LONG' && fvg.type === 'BULLISH') ||
    (direction === 'SHORT' && fvg.type === 'BEARISH')
  );

  // 如果找到FVG，使用FVG中轴线作为入场价格
  if (relevantFVGs.length > 0) {
    const lastFVG = relevantFVGs[relevantFVGs.length - 1];

    // LONG: 在FVG中轴线或下沿附近入场
    // SHORT: 在FVG中轴线或上沿附近入场
    if (direction === 'LONG') {
      const fvgHeight = lastFVG.top - lastFVG.bottom;
      const entryPrice = lastFVG.bottom + fvgHeight * CONFIG.FVG_ENTRY_RATIO;
      
      // 检查价格是否在FVG范围内或接近
      const inFVG = currentPrice >= lastFVG.bottom && currentPrice <= lastFVG.top;
      const distance = Math.abs(currentPrice - entryPrice) / currentPrice;
      const nearFVG = distance < MAX_ENTRY_DISTANCE;
      
      return {
        price: entryPrice,
        type: 'FVG_MID',
        description: inFVG ? `FVG范围内入场 (${lastFVG.bottom.toFixed(4)} - ${lastFVG.top.toFixed(4)})` : `FVG中轴线目标 (${lastFVG.bottom.toFixed(4)} - ${lastFVG.top.toFixed(4)})`,
        fvg: lastFVG,
        tradable: inFVG || nearFVG,
        inFVG,
        distance
      };
    } else {
      const fvgHeight = lastFVG.top - lastFVG.bottom;
      const entryPrice = lastFVG.top - fvgHeight * CONFIG.FVG_ENTRY_RATIO;
      
      const inFVG = currentPrice >= lastFVG.bottom && currentPrice <= lastFVG.top;
      const distance = Math.abs(currentPrice - entryPrice) / currentPrice;
      const nearFVG = distance < MAX_ENTRY_DISTANCE;
      
      return {
        price: entryPrice,
        type: 'FVG_MID',
        description: inFVG ? `FVG范围内入场 (${lastFVG.bottom.toFixed(4)} - ${lastFVG.top.toFixed(4)})` : `FVG中轴线目标 (${lastFVG.bottom.toFixed(4)} - ${lastFVG.top.toFixed(4)})`,
        fvg: lastFVG,
        tradable: inFVG || nearFVG,
        inFVG,
        distance
      };
    }
  }

  // 2. 寻找匹配的订单块
  const relevantOBs = obList.filter(ob =>
    (direction === 'LONG' && ob.type === 'BULLISH') ||
    (direction === 'SHORT' && ob.type === 'BEARISH')
  );

  if (relevantOBs.length > 0) {
    const lastOB = relevantOBs[relevantOBs.length - 1];

    if (direction === 'LONG') {
      // 在订单块上沿附近入场
      const entryPrice = lastOB.high * (1 + CONFIG.OB_ENTRY_OFFSET);
      return {
        price: entryPrice,
        type: 'OB_EDGE',
        description: `订单块边缘入场 (OB: ${lastOB.low.toFixed(4)} - ${lastOB.high.toFixed(4)})`,
        ob: lastOB
      };
    } else {
      const entryPrice = lastOB.low * (1 - CONFIG.OB_ENTRY_OFFSET);
      return {
        price: entryPrice,
        type: 'OB_EDGE',
        description: `订单块边缘入场 (OB: ${lastOB.low.toFixed(4)} - ${lastOB.high.toFixed(4)})`,
        ob: lastOB
      };
    }
  }

  // 3. 使用摆动点作为入场参考
  const { swingHighs, swingLows } = swingPoints;

  if (direction === 'LONG' && swingLows.length > 0) {
    const lastSwingLow = swingLows[swingLows.length - 1];
    // 在摆动低点上方一点入场
    const entryPrice = lastSwingLow.price * (1 + CONFIG.OB_ENTRY_OFFSET);
    return {
      price: entryPrice,
      type: 'SWING_LOW',
      description: `摆动低点支撑入场 (${lastSwingLow.price.toFixed(4)})`,
      swing: lastSwingLow
    };
  }

  if (direction === 'SHORT' && swingHighs.length > 0) {
    const lastSwingHigh = swingHighs[swingHighs.length - 1];
    // 在摆动高点下方一点入场
    const entryPrice = lastSwingHigh.price * (1 - CONFIG.OB_ENTRY_OFFSET);
    return {
      price: entryPrice,
      type: 'SWING_HIGH',
      description: `摆动高点阻力入场 (${lastSwingHigh.price.toFixed(4)})`,
      swing: lastSwingHigh
    };
  }

  // 4.  fallback: 使用当前价格(但这不是理想的SMC入场)
  return {
    price: currentPrice,
    type: 'CURRENT_PRICE',
    description: '当前价格入场(无理想技术位)',
    fallback: true
  };
}

/**
 * 计算止损价格
 */
function calculateSL(direction, entryPrice, klines, fvgList, obList, swingPoints, atr) {
  const { swingHighs, swingLows } = swingPoints;

  if (direction === 'LONG') {
    // 1. 优先使用FVG下沿作为止损
    const bullishFVGs = fvgList.filter(f => f.type === 'BULLISH');
    if (bullishFVGs.length > 0) {
      const lastFVG = bullishFVGs[bullishFVGs.length - 1];
      return {
        price: lastFVG.bottom * 0.998,  // FVG下沿下方0.2%
        type: 'FVG_BOTTOM',
        description: 'FVG下沿止损'
      };
    }

    // 2. 使用订单块下沿
    const bullishOBs = obList.filter(o => o.type === 'BULLISH');
    if (bullishOBs.length > 0) {
      const lastOB = bullishOBs[bullishOBs.length - 1];
      return {
        price: lastOB.low * 0.998,
        type: 'OB_LOW',
        description: '订单块下沿止损'
      };
    }

    // 3. 使用摆动低点
    if (swingLows.length > 0) {
      const lastSwingLow = swingLows[swingLows.length - 1];
      return {
        price: lastSwingLow.price * 0.995,
        type: 'SWING_LOW',
        description: '摆动低点止损'
      };
    }

    // 4. fallback: ATR止损
    return {
      price: entryPrice - atr * 1.5,
      type: 'ATR',
      description: 'ATR止损'
    };
  } else {
    // SHORT方向
    const bearishFVGs = fvgList.filter(f => f.type === 'BEARISH');
    if (bearishFVGs.length > 0) {
      const lastFVG = bearishFVGs[bearishFVGs.length - 1];
      return {
        price: lastFVG.top * 1.002,
        type: 'FVG_TOP',
        description: 'FVG上沿止损'
      };
    }

    const bearishOBs = obList.filter(o => o.type === 'BEARISH');
    if (bearishOBs.length > 0) {
      const lastOB = bearishOBs[bearishOBs.length - 1];
      return {
        price: lastOB.high * 1.002,
        type: 'OB_HIGH',
        description: '订单块上沿止损'
      };
    }

    if (swingHighs.length > 0) {
      const lastSwingHigh = swingHighs[swingHighs.length - 1];
      return {
        price: lastSwingHigh.price * 1.005,
        type: 'SWING_HIGH',
        description: '摆动高点止损'
      };
    }

    return {
      price: entryPrice + atr * 1.5,
      type: 'ATR',
      description: 'ATR止损'
    };
  }
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

  // 检测技术结构
  const swingPoints = findSwingPoints(klines);
  const fvgList = detectFVG(klines);
  const obList = detectOrderBlocks(klines);
  const bosList = detectBOS(klines, swingPoints);

  // 确定方向
  let direction = 'LONG';
  let confidence = 50;
  let directionReason = '';

  // 基于MA和RSI确定方向
  if (ma20 && ma50) {
    if (ma20 > ma50 && rsi > 50) {
      direction = 'LONG';
      confidence = 60 + (rsi - 50) * 0.5;
      directionReason = 'MA20>MA50且RSI>50';
    } else if (ma20 < ma50 && rsi < 50) {
      direction = 'SHORT';
      confidence = 60 + (50 - rsi) * 0.5;
      directionReason = 'MA20<MA50且RSI<50';
    }
  }

  // 基于FVG确认方向
  const recentFVGs = fvgList.slice(-3);
  const bullishFVGs = recentFVGs.filter(f => f.type === 'BULLISH').length;
  const bearishFVGs = recentFVGs.filter(f => f.type === 'BEARISH').length;

  if (bullishFVGs > bearishFVGs && direction === 'LONG') {
    confidence += 10;
    directionReason += ', 看涨FVG占优';
  } else if (bearishFVGs > bullishFVGs && direction === 'SHORT') {
    confidence += 10;
    directionReason += ', 看跌FVG占优';
  }

  // 计算SMC入场价格
  const entryInfo = calculateSMCEntryPrice(direction, klines, fvgList, obList, swingPoints, currentPrice);
  const entryPrice = entryInfo.price;

  // 计算止损
  const slInfo = calculateSL(direction, entryPrice, klines, fvgList, obList, swingPoints, atr);
  const stopLoss = slInfo.price;

  // 计算止盈 (基于风险回报比)
  const risk = Math.abs(entryPrice - stopLoss);
  let tp1, tp2;

  if (direction === 'LONG') {
    tp1 = entryPrice + risk * 2;  // 1:2 RRR
    tp2 = entryPrice + risk * 3;  // 1:3 RRR
  } else {
    tp1 = entryPrice - risk * 2;
    tp2 = entryPrice - risk * 3;
  }

  // 计算实际RRR
  const rrr = risk > 0 ? (tp1 - entryPrice) / risk : 2;

  // 确定评级
  let rating = 'C';
  let signalType = 'CANDIDATE';

  if (confidence >= 85 && entryInfo.type !== 'CURRENT_PRICE') {
    rating = 'S';
    signalType = 'TRADABLE';
  } else if (confidence >= 70 && entryInfo.type !== 'CURRENT_PRICE') {
    rating = 'A';
    signalType = 'TRADABLE';
  } else if (confidence >= 55) {
    rating = 'B';
    signalType = entryInfo.type !== 'CURRENT_PRICE' ? 'TRADABLE' : 'CANDIDATE';
  }

  // 如果入场价就是当前价且没有技术位支撑，降级为候选
  if (entryInfo.type === 'CURRENT_PRICE') {
    signalType = 'CANDIDATE';
    rating = 'C';
  }

  return {
    id: `${symbol}_${Date.now()}`,
    symbol,
    direction,
    entry_price: entryPrice,
    entry_type: entryInfo.type,
    entry_description: entryInfo.description,
    current_price: currentPrice,
    sl: stopLoss,
    sl_type: slInfo.type,
    sl_description: slInfo.description,
    tp1,
    tp2,
    rrr,
    rating,
    score: Math.round(confidence),
    signal_type: signalType,
    status: 'ACTIVE',
    timestamp: new Date().toISOString(),
    timeframe: '4H',
    data_source: 'Gate.io API',
    direction_reason: directionReason,
    structure: {
      fvg: fvgList.slice(-3),
      order_blocks: obList.slice(-3),
      swing_highs: swingPoints.swingHighs.slice(-3),
      swing_lows: swingPoints.swingLows.slice(-3),
      bos: bosList
    },
    atr: atr
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
  calculateRSI,
  detectFVG,
  detectOrderBlocks,
  detectBOS
};
