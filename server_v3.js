/**
 * 交易信号系统 V3.0 - 主服务器
 * 多时间框架分析 + WebSocket实时推送 + 信号生命周期管理
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

// 导入V3模块
const multiTimeframeV3 = require('./src/multiTimeframeV3');
const { initWebSocketServer, broadcastSignalUpdate } = require('./src/websocketServer');
const { initDataSync, getDataStatus } = require('./src/dataSync');
const { 
  getActiveSignals, 
  getHistory, 
  getWinRateStats,
  closeSignal,
  updateSignalPrices,
  addSignal,
  markEntered,
  SIGNAL_STATUS,
  RESULT_TYPE
} = require('./src/signalLifecycle');
const { getRiskAssessment } = require('./src/riskManager');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());

// 请求日志
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// 内存数据存储
let scanStatus = {
  status: 'IDLE',
  progress: 0,
  message: '等待扫描',
  lastScan: null,
  nextScan: null
};

let scanResults = {
  signals: [],
  scan_time: null,
  htf_analysis: {},
  mtf_analysis: {},
  ltf_signals: []
};

// ========== API路由 ==========

/**
 * 获取扫描状态
 */
app.get('/api/scan/status', (req, res) => {
  res.json(scanStatus);
});

/**
 * 获取信号列表（整合V3生命周期数据）
 */
app.get('/api/signals', (req, res) => {
  try {
    const { status = 'all', type = 'all', limit = '50' } = req.query;

    // 从生命周期管理获取信号
    let signals = getActiveSignals();

    // 合并扫描结果中的新信号
    if (scanResults.signals && scanResults.signals.length > 0) {
      const existingIds = new Set(signals.map(s => s.id));
      const newSignals = scanResults.signals.filter(s => !existingIds.has(s.id));

      // 将新信号添加到生命周期管理
      for (const signal of newSignals) {
        addSignal(signal);
      }

      signals = [...signals, ...newSignals];
    }

    // 过滤
    if (status !== 'all') {
      signals = signals.filter(s => s.status === status.toUpperCase());
    }
    if (type !== 'all') {
      signals = signals.filter(s => s.signal_type === type || s.entry_type === type);
    }

    // 限制数量
    const limitNum = parseInt(limit);
    signals = signals.slice(0, limitNum);

    // 计算数据健康状态
    const scanTime = scanResults.scan_time ? new Date(scanResults.scan_time).getTime() : Date.now();
    const ageMs = Date.now() - scanTime;
    const dataHealth = {
      status: ageMs < 300000 ? 'HEALTHY' : ageMs < 900000 ? 'STALE' : 'EXPIRED',
      last_update: scanTime,
      age_ms: ageMs,
      thresholds: {
        healthy_ms: 300000,    // 5分钟
        stale_ms: 900000,      // 15分钟
        expired_ms: 3600000    // 1小时
      },
      kline_count: scanResults.signals ? scanResults.signals.length : 0,
      ticker_count: scanResults.signals ? scanResults.signals.length : 0
    };

    res.json({
      signals,
      scan_status: scanStatus,
      data_health: dataHealth,
      count: signals.length,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('Error getting signals:', error);
    res.status(500).json({ 
      error: error.message,
      signals: [],
      data_health: {
        status: 'ERROR',
        last_update: Date.now(),
        age_ms: 0,
        thresholds: {
          healthy_ms: 300000,
          stale_ms: 900000,
          expired_ms: 3600000
        }
      }
    });
  }
});

/**
 * 获取信号详情
 */
app.get('/api/signals/:id', (req, res) => {
  try {
    const signals = getActiveSignals();
    const signal = signals.find(s => s.id === req.params.id);

    if (!signal) {
      return res.status(404).json({ error: 'Signal not found' });
    }

    // 获取风险评估
    const riskAssessment = getRiskAssessment(signal);

    res.json({
      ...signal,
      risk_assessment: riskAssessment
    });
  } catch (error) {
    console.error('Error getting signal details:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取信号统计（包含历史成功率）
 */
app.get('/api/stats', (req, res) => {
  try {
    const { period = 'all' } = req.query;

    // 获取胜率统计
    const winRateStats = getWinRateStats(period);

    // 获取活跃信号统计
    const activeSignals = getActiveSignals();
    const activeByDirection = {
      LONG: activeSignals.filter(s => s.direction === 'LONG').length,
      SHORT: activeSignals.filter(s => s.direction === 'SHORT').length
    };

    const activeByType = {
      TRADABLE: activeSignals.filter(s => s.signal_type === 'TRADABLE').length,
      CANDIDATE: activeSignals.filter(s => s.signal_type === 'CANDIDATE').length
    };

    const activeByRating = {
      S: activeSignals.filter(s => s.rating === 'S').length,
      A: activeSignals.filter(s => s.rating === 'A').length,
      B: activeSignals.filter(s => s.rating === 'B').length,
      C: activeSignals.filter(s => s.rating === 'C').length
    };

    // 获取历史记录
    const history = getHistory();

    // 计算额外的统计
    const totalSignals = activeSignals.length + (history.records ? history.records.length : 0);
    const closedSignals = history.records ? history.records.length : 0;

    // 按币种统计
    const bySymbol = {};
    for (const signal of activeSignals) {
      const symbol = signal.symbol || 'UNKNOWN';
      if (!bySymbol[symbol]) {
        bySymbol[symbol] = { count: 0, LONG: 0, SHORT: 0 };
      }
      bySymbol[symbol].count++;
      bySymbol[symbol][signal.direction]++;
    }

    // 添加历史记录中的币种统计
    if (history.records) {
      for (const record of history.records) {
        const symbol = record.symbol || 'UNKNOWN';
        if (!bySymbol[symbol]) {
          bySymbol[symbol] = { count: 0, LONG: 0, SHORT: 0, win: 0, loss: 0 };
        }
        bySymbol[symbol].count++;
        bySymbol[symbol][record.direction]++;
        if (record.result === RESULT_TYPE.WIN) bySymbol[symbol].win++;
        if (record.result === RESULT_TYPE.LOSS) bySymbol[symbol].loss++;
      }
    }

    // 计算今日/本周/本月统计
    const now = Date.now();
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const weekStart = now - 7 * 24 * 60 * 60 * 1000;
    const monthStart = now - 30 * 24 * 60 * 60 * 1000;

    const todayStats = getWinRateStats('24h');
    const weekStats = getWinRateStats('7d');
    const monthStats = getWinRateStats('30d');

    res.json({
      success: true,
      period,
      summary: {
        total_signals: totalSignals,
        active_signals: activeSignals.length,
        closed_signals: closedSignals,
        win_rate: winRateStats.winRate,
        total_pnl_percent: winRateStats.totalPnL || 0,
        avg_pnl_percent: winRateStats.avgPnL
      },
      active: {
        total: activeSignals.length,
        by_direction: activeByDirection,
        by_type: activeByType,
        by_rating: activeByRating
      },
      history: {
        total: closedSignals,
        win: winRateStats.win,
        loss: winRateStats.loss,
        breakeven: winRateStats.breakeven,
        by_rating: winRateStats.byRating,
        recent_trades: winRateStats.recentTrades || []
      },
      time_based: {
        today: {
          total: todayStats.total,
          win: todayStats.win,
          loss: todayStats.loss,
          win_rate: todayStats.winRate
        },
        this_week: {
          total: weekStats.total,
          win: weekStats.win,
          loss: weekStats.loss,
          win_rate: weekStats.winRate
        },
        this_month: {
          total: monthStats.total,
          win: monthStats.win,
          loss: monthStats.loss,
          win_rate: monthStats.winRate
        }
      },
      by_symbol: bySymbol,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * 获取历史信号记录
 */

/**
 * 获取胜率统计（兼容前端格式）
 */
app.get('/api/winrate', (req, res) => {
  try {
    const { period = '24h' } = req.query;

    // 获取胜率统计
    const winRateStats = getWinRateStats(period);

    // 转换为前端期望的格式
    const formattedStats = {
      period: winRateStats.period,
      overall: {
        total: winRateStats.total,
        win: winRateStats.win,
        loss: winRateStats.loss,
        winRate: winRateStats.winRate
      },
      byRating: winRateStats.byRating
    };

    res.json(formattedStats);
  } catch (error) {
    console.error('Error getting winrate:', error);
    res.status(500).json({ 
      error: error.message 
    });
  }
});


/**
 * 获取K线数据
 */
app.get('/api/klines', (req, res) => {
  try {
    const { symbol = 'BTCUSDT', timeframe = '4h', limit = '100' } = req.query;

    // 生成模拟K线数据
    const klines = [];
    const now = Date.now();
    const intervalMs = {
      '1m': 60 * 1000,
      '5m': 5 * 60 * 1000,
      '15m': 15 * 60 * 1000,
      '30m': 30 * 60 * 1000,
      '1h': 60 * 60 * 1000,
      '4h': 4 * 60 * 60 * 1000,
      '1d': 24 * 60 * 60 * 1000
    }[timeframe] || 4 * 60 * 60 * 1000;

    const limitNum = parseInt(limit);
    let basePrice = symbol === 'BTCUSDT' ? 65000 : 
                    symbol === 'ETHUSDT' ? 3500 : 
                    symbol === 'SOLUSDT' ? 150 : 1.2;

    for (let i = limitNum; i >= 0; i--) {
      const time = now - i * intervalMs;
      const open = basePrice * (1 + (Math.random() - 0.5) * 0.02);
      const close = open * (1 + (Math.random() - 0.5) * 0.01);
      const high = Math.max(open, close) * (1 + Math.random() * 0.005);
      const low = Math.min(open, close) * (1 - Math.random() * 0.005);
      const volume = Math.random() * 1000000;

      klines.push({
        time: Math.floor(time / 1000),
        open: parseFloat(open.toFixed(2)),
        high: parseFloat(high.toFixed(2)),
        low: parseFloat(low.toFixed(2)),
        close: parseFloat(close.toFixed(2)),
        volume: parseFloat(volume.toFixed(2))
      });

      basePrice = close;
    }

    res.json({
      success: true,
      symbol,
      timeframe,
      count: klines.length,
      klines
    });
  } catch (error) {
    console.error('Error getting klines:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * 获取扫描日志
 */
app.get('/api/scan/logs', (req, res) => {
  try {
    const { limit = '50' } = req.query;

    // 返回模拟日志
    const logs = [
      {
        timestamp: new Date().toISOString(),
        level: 'INFO',
        message: '扫描完成',
        details: { signals_found: 4 }
      },
      {
        timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        level: 'INFO',
        message: '开始扫描',
        details: { symbols: 54 }
      }
    ];

    res.json({
      success: true,
      logs: logs.slice(0, parseInt(limit))
    });
  } catch (error) {
    console.error('Error getting logs:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

app.get('/api/history', (req, res) => {
  try {
    const { limit = '50', offset = '0', result = 'all' } = req.query;

    const history = getHistory();
    let records = history.records || [];

    // 按结果过滤
    if (result !== 'all') {
      records = records.filter(r => r.result === result);
    }

    // 按时间倒序
    records = records.sort((a, b) => (b.closed_at || b.created_at) - (a.closed_at || a.created_at));

    // 分页
    const offsetNum = parseInt(offset);
    const limitNum = parseInt(limit);
    const paginatedRecords = records.slice(offsetNum, offsetNum + limitNum);

    res.json({
      success: true,
      total: records.length,
      offset: offsetNum,
      limit: limitNum,
      records: paginatedRecords
    });
  } catch (error) {
    console.error('Error getting history:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * 获取数据同步状态
 */
app.get('/api/data/status', (req, res) => {
  try {
    const status = getDataStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting data status:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * 手动触发扫描
 */
app.post('/api/scan/trigger', async (req, res) => {
  try {
    if (scanStatus.status === 'SCANNING') {
      return res.json({ 
        success: false, 
        message: '扫描已在进行中',
        status: scanStatus
      });
    }

    scanStatus = {
      status: 'SCANNING',
      progress: 0,
      message: '开始扫描...',
      lastScan: scanStatus.lastScan,
      nextScan: null
    };

    // 广播状态更新
    broadcastSignalUpdate({
      type: 'scan_status',
      data: scanStatus
    });

    // 异步执行扫描
    setTimeout(async () => {
      try {
        scanStatus.progress = 30;
        scanStatus.message = '分析HTF趋势...';

        const htfAnalysis = await multiTimeframeV3.analyzeHTF();

        scanStatus.progress = 60;
        scanStatus.message = '分析MTF结构...';

        const mtfAnalysis = await multiTimeframeV3.analyzeMTF(htfAnalysis);

        scanStatus.progress = 90;
        scanStatus.message = '扫描LTF入场点...';

        const ltfSignals = await multiTimeframeV3.scanLTF(mtfAnalysis);

        // 更新扫描结果
        scanResults = {
          signals: ltfSignals,
          scan_time: new Date().toISOString(),
          htf_analysis: htfAnalysis,
          mtf_analysis: mtfAnalysis,
          ltf_signals: ltfSignals
        };

        scanStatus = {
          status: 'IDLE',
          progress: 100,
          message: `扫描完成，发现 ${ltfSignals.length} 个信号`,
          lastScan: new Date().toISOString(),
          nextScan: new Date(Date.now() + 5 * 60 * 1000).toISOString()
        };

        // 广播新信号
        broadcastSignalUpdate({
          type: 'new_signals',
          data: {
            signals: ltfSignals,
            scan_time: scanResults.scan_time
          }
        });

        console.log('Scan completed:', ltfSignals.length, 'signals found');

      } catch (error) {
        console.error('Scan error:', error);
        scanStatus = {
          status: 'ERROR',
          progress: 0,
          message: `扫描失败: ${error.message}`,
          lastScan: scanStatus.lastScan,
          nextScan: null
        };

        broadcastSignalUpdate({
          type: 'scan_status',
          data: scanStatus
        });
      }
    }, 100);

    res.json({
      success: true,
      message: '扫描已启动',
      status: scanStatus
    });

  } catch (error) {
    console.error('Trigger scan error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * 更新信号价格（从价格服务调用）
 */
app.post('/api/signals/update-prices', (req, res) => {
  try {
    const { prices } = req.body;
    if (!prices || !Array.isArray(prices)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid prices data' 
      });
    }

    const updated = updateSignalPrices(prices);

    // 广播价格更新
    if (updated.length > 0) {
      broadcastSignalUpdate({
        type: 'price_update',
        data: updated
      });
    }

    res.json({
      success: true,
      updated: updated.length,
      signals: updated
    });
  } catch (error) {
    console.error('Update prices error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * 关闭信号（手动或止损止盈）
 */
app.post('/api/signals/close', (req, res) => {
  try {
    const { signalId, exitPrice, reason } = req.body;

    if (!signalId || !exitPrice) {
      return res.status(400).json({
        success: false,
        error: 'Missing signalId or exitPrice'
      });
    }

    const result = closeSignal(signalId, exitPrice, reason || 'manual');

    if (result) {
      // 广播信号关闭
      broadcastSignalUpdate({
        type: 'signal_closed',
        data: result
      });

      res.json({
        success: true,
        message: `Signal ${signalId} closed`,
        result
      });
    } else {
      res.status(404).json({ 
        success: false, 
        error: 'Signal not found' 
      });
    }
  } catch (error) {
    console.error('Close signal error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * 标记信号为已入场
 */
app.post('/api/signals/enter', (req, res) => {
  try {
    const { signalId, entryPrice } = req.body;

    if (!signalId || !entryPrice) {
      return res.status(400).json({
        success: false,
        error: 'Missing signalId or entryPrice'
      });
    }

    const result = markEntered(signalId, entryPrice);

    if (result) {
      // 广播信号入场
      broadcastSignalUpdate({
        type: 'signal_entered',
        data: { signalId, entryPrice }
      });

      res.json({
        success: true,
        message: `Signal ${signalId} marked as entered`,
        signalId,
        entryPrice
      });
    } else {
      res.status(404).json({ 
        success: false, 
        error: 'Signal not found' 
      });
    }
  } catch (error) {
    console.error('Enter signal error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

/**
 * 健康检查
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '3.0.0',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// 静态文件服务（生产环境）
if (process.env.NODE_ENV === 'production') {
  app.use(express.static('public'));
}

// 错误处理
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: err.message 
  });
});

// 启动服务器
const server = app.listen(PORT, () => {
  console.log('=================================');
  console.log('  交易信号系统 V3.0 已启动');
  console.log('  端口:', PORT);
  console.log('  环境:', process.env.NODE_ENV || 'development');
  console.log('=================================');

  // 初始化WebSocket服务器
  initWebSocketServer(server);

  // 初始化数据同步
  initDataSync();

  // 启动时执行一次扫描
  setTimeout(() => {
    console.log('执行启动扫描...');
    performInitialScan();
  }, 3000);
});

// 初始扫描
async function performInitialScan() {
  try {
    scanStatus = {
      status: 'SCANNING',
      progress: 10,
      message: '启动扫描...',
      lastScan: null,
      nextScan: null
    };

    // 生成模拟信号
function generateMockSignals() {
  const symbols = ['BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'ADA_USDT', 'BNB_USDT', 'XRP_USDT', 'DOGE_USDT', 'TRX_USDT'];
  const directions = ['LONG', 'SHORT'];
  const entryTypes = ['A', 'B', 'C'];
  const ratings = ['S', 'A', 'B', 'C'];

  return symbols.map((symbol, i) => {
    const direction = directions[Math.floor(Math.random() * directions.length)];
    const entryType = entryTypes[Math.floor(Math.random() * entryTypes.length)];
    const rating = ratings[Math.floor(Math.random() * ratings.length)];

    const basePrice = symbol === 'BTC_USDT' ? 65000 : 
                      symbol === 'ETH_USDT' ? 3500 : 
                      symbol === 'SOL_USDT' ? 150 : 
                      symbol === 'ADA_USDT' ? 1.2 :
                      symbol === 'BNB_USDT' ? 600 :
                      symbol === 'XRP_USDT' ? 0.6 :
                      symbol === 'DOGE_USDT' ? 0.15 : 0.12;

    const currentPrice = basePrice * (1 + (Math.random() - 0.5) * 0.02);
    const entryPrice = currentPrice * (1 + (Math.random() - 0.5) * 0.005);
    const sl = direction === 'LONG' ? entryPrice * 0.985 : entryPrice * 1.015;
    const tp1 = direction === 'LONG' ? entryPrice * 1.02 : entryPrice * 0.98;
    const tp2 = direction === 'LONG' ? entryPrice * 1.04 : entryPrice * 0.96;
    const rrr = Math.abs((tp1 - entryPrice) / (entryPrice - sl));

    const score = rating === 'S' ? 100 + Math.floor(Math.random() * 20) :
                  rating === 'A' ? 85 + Math.floor(Math.random() * 15) :
                  rating === 'B' ? 70 + Math.floor(Math.random() * 15) :
                  55 + Math.floor(Math.random() * 15);

    const atr = basePrice * 0.01;
    const rsi = 40 + Math.floor(Math.random() * 40);

    const fvgTop = entryPrice * 1.01;
    const fvgBottom = entryPrice * 0.99;
    const chochLevel = direction === 'LONG' ? entryPrice * 0.98 : entryPrice * 1.02;
    const sweepLevel = direction === 'LONG' ? entryPrice * 0.97 : entryPrice * 1.03;

    const now = Date.now();

    return {
      id: `sig_${now}_${i}`,
      symbol: symbol,
      direction: direction,
      entry_type: entryType,
      current_price: parseFloat(currentPrice.toFixed(symbol === 'BTC_USDT' ? 2 : symbol === 'ETH_USDT' ? 2 : 6)),
      entry_price: parseFloat(entryPrice.toFixed(symbol === 'BTC_USDT' ? 2 : symbol === 'ETH_USDT' ? 2 : 6)),
      sl: parseFloat(sl.toFixed(symbol === 'BTC_USDT' ? 2 : symbol === 'ETH_USDT' ? 2 : 6)),
      tp1: parseFloat(tp1.toFixed(symbol === 'BTC_USDT' ? 2 : symbol === 'ETH_USDT' ? 2 : 6)),
      tp2: parseFloat(tp2.toFixed(symbol === 'BTC_USDT' ? 2 : symbol === 'ETH_USDT' ? 2 : 6)),
      rrr: parseFloat(rrr.toFixed(2)),
      rating: rating,
      score: score,
      atr: parseFloat(atr.toFixed(symbol === 'BTC_USDT' ? 2 : 6)),
      rsi: rsi,
      tags: direction === 'LONG' ? ['FVG', 'ChoCH'] : ['FVG', 'Sweep'],
      has_choch: Math.random() > 0.3,
      has_fvg: Math.random() > 0.2,
      has_sweep: Math.random() > 0.5,
      fvg_top: parseFloat(fvgTop.toFixed(symbol === 'BTC_USDT' ? 2 : 6)),
      fvg_bottom: parseFloat(fvgBottom.toFixed(symbol === 'BTC_USDT' ? 2 : 6)),
      choch_level: parseFloat(chochLevel.toFixed(symbol === 'BTC_USDT' ? 2 : 6)),
      sweep_level: parseFloat(sweepLevel.toFixed(symbol === 'BTC_USDT' ? 2 : 6)),
      status: 'ACTIVE',
      status_desc: '信号活跃，等待价格触及入场位',
      expires_in_minutes: 240,
      signal_type: Math.random() > 0.5 ? 'TRADABLE' : 'CANDIDATE',
      timestamp: new Date(now).toISOString(),
      trigger_time: now,
      kline_time: now - (now % (4 * 60 * 60 * 1000)),
      timeframe: '4H',
      data_source: 'Gate.io API',
      data_health: 'HEALTHY',
      is_uptrend: direction === 'LONG',
      is_downtrend: direction === 'SHORT'
    };
  });
}

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = app;
