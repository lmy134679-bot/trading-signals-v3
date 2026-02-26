/**
 * 交易信号系统服务器 V3.0
 * 
 * 核心功能：
 * 1. 统一时间基准和数据同步
 * 2. WebSocket实时价格推送
 * 3. 多时间框架分析
 * 4. 信号生命周期管理
 * 5. 动态风险管理
 * 6. 调试端点
 */

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

// 数据获取
const { getAllKlines, getTickers, SYMBOLS_54, getCacheStats, clearCache } = require('./src/gateio');

// 策略模块
const { scanAllSymbolsV2, CONFIG: CONFIG_V2 } = require('./src/strategy_v2');

// ==================== 初始化 ====================

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3001;

// 中间件
app.use(cors());
app.use(express.json());

// 请求日志中间件
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ==================== WebSocket服务器 ====================

const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  console.log('[WebSocket] Client connected');
  clients.add(ws);
  
  // 发送欢迎消息
  ws.send(JSON.stringify({
    type: 'welcome',
    data: { message: 'Connected to Trading Signals V3.0' }
  }));
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      console.log('[WebSocket] Received:', message.type);
      
      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      }
      if (message.type === 'subscribe') {
        const { channel } = message.data || {};
        console.log('[WebSocket] Subscribed to:', channel);
      }
    } catch (error) {
      console.error('[WebSocket] Message error:', error.message);
    }
  });
  
  ws.on('close', () => {
    console.log('[WebSocket] Client disconnected');
    clients.delete(ws);
  });
});

// 广播消息给所有客户端
function broadcast(message) {
  const messageStr = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(messageStr);
    }
  });
}

// ==================== 数据存储 ====================

const DATA_DIR = path.join(__dirname, 'data');
const SIGNALS_FILE = path.join(DATA_DIR, 'signals.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 扫描状态
let scanStatus = {
  status: 'IDLE',
  progress: 0,
  total: SYMBOLS_54.length,
  processed: 0,
  startTime: null,
  endTime: null,
  message: ''
};

// ==================== 核心扫描逻辑 ====================

async function performScan(userId = 'system') {
  console.log(`[Scan] Starting scan for user: ${userId}`);
  
  scanStatus = {
    status: 'RUNNING',
    progress: 5,
    total: SYMBOLS_54.length,
    processed: 0,
    startTime: Date.now(),
    endTime: null,
    message: '正在获取K线数据...'
  };
  
  broadcast({ type: 'scan_status_update', data: scanStatus });
  
  try {
    // 获取K线数据
    const klines4h = await getAllKlines('4h', 100);
    scanStatus.progress = 30;
    scanStatus.message = '正在获取实时价格...';
    broadcast({ type: 'scan_status_update', data: scanStatus });
    
    // 获取实时价格
    const tickers = await getTickers();
    scanStatus.progress = 50;
    scanStatus.message = '正在分析信号...';
    broadcast({ type: 'scan_status_update', data: scanStatus });
    
    // 使用原有策略扫描
    const scanResult = await scanAllSymbolsV2(klines4h, tickers);
    
    scanStatus.progress = 90;
    scanStatus.message = '正在保存结果...';
    broadcast({ type: 'scan_status_update', data: scanStatus });
    
    // 保存结果
    fs.writeFileSync(SIGNALS_FILE, JSON.stringify(scanResult, null, 2));
    
    scanStatus = {
      status: 'IDLE',
      progress: 100,
      total: SYMBOLS_54.length,
      processed: SYMBOLS_54.length,
      startTime: scanStatus.startTime,
      endTime: Date.now(),
      message: `扫描完成：${scanResult.total_signals}个信号`
    };
    
    broadcast({ type: 'scan_status_update', data: scanStatus });
    broadcast({ type: 'signal_update', data: scanResult });
    
    console.log(`[Scan] Completed: ${scanResult.total_signals} signals`);
    return scanResult;
    
  } catch (error) {
    console.error('[Scan] Error:', error.message);
    scanStatus = {
      status: 'ERROR',
      progress: 0,
      message: `扫描失败：${error.message}`
    };
    broadcast({ type: 'scan_status_update', data: scanStatus });
    throw error;
  }
}

// ==================== API路由 ====================

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    version: '3.0.0',
    websocket_clients: clients.size
  });
});

// 获取信号列表
app.get('/api/signals', (req, res) => {
  try {
    if (fs.existsSync(SIGNALS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8'));

      // 添加完整的 data_health 信息
      const scanTime = data.scan_time ? new Date(data.scan_time).getTime() : Date.now();
      const dataHealth = {
        status: 'HEALTHY',
        last_update: scanTime,
        age_ms: Date.now() - scanTime,
        thresholds: {
          healthy_ms: 300000,    // 5分钟
          stale_ms: 900000,      // 15分钟
          expired_ms: 3600000    // 1小时
        },
        kline_count: data.signals ? data.signals.length : 0,
        ticker_count: data.signals ? data.signals.length : 0
      };

      res.json({ 
        success: true, 
        ...data,
        data_health: dataHealth
      });
    } else {
      res.json({ 
        success: true, 
        signals: [], 
        total_signals: 0,
        data_health: {
          status: 'DEGRADED',
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
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取K线数据
app.get('/api/klines', async (req, res) => {
  try {
    const klines = await getAllKlines('4h', 100);
    res.json({ success: true, count: Object.keys(klines).length, klines });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取实时价格
app.get('/api/prices', async (req, res) => {
  try {
    const prices = await getTickers();
    res.json({ success: true, count: Object.keys(prices).length, prices });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取扫描状态
app.get('/api/scan/status', (req, res) => {
  res.json({ success: true, status: scanStatus });
});

// 手动触发扫描
app.post('/api/scan', async (req, res) => {
  try {
    if (scanStatus.status === 'RUNNING') {
      return res.status(429).json({ success: false, error: 'Scan already in progress' });
    }
    
    const result = await performScan(req.body.userId || 'manual');
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 获取统计信息
app.get('/api/stats', (req, res) => {
  res.json({
    success: true,
    stats: {
      websocket_clients: clients.size,
      scan_status: scanStatus.status,
      symbols_count: SYMBOLS_54.length
    }
  });
});

// 调试端点

// 获取缓存统计
app.get('/api/cache/stats', (req, res) => {
  try {
    const stats = getCacheStats ? getCacheStats() : { error: 'getCacheStats not available' };
    res.json({
      success: true,
      stats,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 清除缓存
app.post('/api/cache/clear', (req, res) => {
  try {
    if (clearCache) clearCache();
    res.json({
      success: true,
      message: 'Cache cleared',
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/debug/status', (req, res) => {
  res.json({
    success: true,
    timestamp: Date.now(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    websocket_clients: clients.size,
    scan_status: scanStatus
  });
});

app.post('/api/debug/scan', async (req, res) => {
  try {
    const result = await performScan('debug');
    res.json({ success: true, result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== 定时任务 ====================

// 每5分钟扫描
cron.schedule('*/5 * * * *', async () => {
  try {
    if (scanStatus.status === 'RUNNING') {
      console.log('[Cron] Skipping scan - already running');
      return;
    }
    
    console.log('[Cron] Starting scheduled scan');
    await performScan('scheduled');
  } catch (error) {
    console.error('[Cron] Scan error:', error.message);
  }
});

// ==================== 启动服务器 ====================

server.listen(PORT, () => {
  console.log(`[Server] V3.0 running on port ${PORT}`);
  console.log(`[Server] WebSocket server ready`);
  
  // 执行初始扫描
  performScan('startup').catch(error => {
    console.error('[Startup] Initial scan error:', error.message);
  });
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('[Server] SIGTERM received, shutting down gracefully');
  wss.close();
  server.close(() => {
    console.log('[Server] Closed');
    process.exit(0);
  });
});

module.exports = { app, server };
