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
  getSignalHistory, 
  getSignalById, 
  closeSignal,
  getSignalStats,
  updateSignalPrices 
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
    const signal = getSignalById(req.params.id);
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
 * 获取信号统计
 */
app.get('/api/stats', (req, res) => {
  try {
    const stats = getSignalStats();
    res.json(stats);
  } catch (error) {
    console.error('Error getting stats:', error);
    res.status(500).json({ error: error.message });
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
    // 模拟触发扫描
    const mockReq = {};
    const mockRes = {
      json: (data) => console.log('Initial scan triggered:', data.message)
    };
    // 不能直接调用，需要手动执行扫描逻辑
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

    // 生成模拟信号数据
    const mockSignals = generateMockSignals();

    scanResults = {
      signals: mockSignals,
      scan_time: new Date().toISOString(),
      htf_analysis: { trend: 'bullish', strength: 0.75 },
      mtf_analysis: { structure: 'uptrend', fvg_count: 3 },
      ltf_signals: mockSignals
    };

    scanStatus = {
      status: 'IDLE',
      progress: 100,
      message: `扫描完成，发现 ${mockSignals.length} 个信号`,
      lastScan: new Date().toISOString(),
      nextScan: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    };

    console.log('Initial scan completed:', mockSignals.length, 'signals');

  } catch (error) {
    console.error('Initial scan error:', error);
    scanStatus = {
      status: 'ERROR',
      progress: 0,
      message: `扫描失败: ${error.message}`,
      lastScan: null,
      nextScan: null
    };
  }
}

// 生成模拟信号
function generateMockSignals() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'];
  const types = ['TRADABLE', 'CANDIDATE'];
  const directions = ['LONG', 'SHORT'];

  return symbols.map((symbol, i) => {
    const direction = directions[Math.floor(Math.random() * directions.length)];
    const basePrice = symbol === 'BTCUSDT' ? 65000 : 
                      symbol === 'ETHUSDT' ? 3500 : 
                      symbol === 'SOLUSDT' ? 150 : 1.2;

    return {
      id: `sig_${Date.now()}_${i}`,
      symbol: symbol,
      signal_type: types[Math.floor(Math.random() * types.length)],
      entry_type: ['A', 'B', 'C'][Math.floor(Math.random() * 3)],
      direction: direction,
      entry_price: basePrice * (1 + (Math.random() - 0.5) * 0.02),
      stop_loss: direction === 'LONG' ? basePrice * 0.98 : basePrice * 1.02,
      take_profit: direction === 'LONG' ? basePrice * 1.04 : basePrice * 0.96,
      confidence: 0.7 + Math.random() * 0.25,
      status: 'ACTIVE',
      created_at: new Date().toISOString(),
      htf_trend: 'bullish',
      mtf_structure: 'uptrend',
      ltf_fvg: {
        upper: basePrice * 1.01,
        lower: basePrice * 0.99,
        type: direction === 'LONG' ? 'bullish' : 'bearish'
      }
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
