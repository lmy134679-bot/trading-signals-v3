/**
 * 信号生命周期管理
 * 
 * 跟踪信号从生成到结束的全过程：
 * PENDING -> ACTIVE -> ENTERED -> CLOSED (TP/SL/EXPIRED)
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SIGNALS_HISTORY_FILE = path.join(DATA_DIR, 'signals_history.json');
const ACTIVE_SIGNALS_FILE = path.join(DATA_DIR, 'active_signals.json');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 信号状态
const SIGNAL_STATUS = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  ENTERED: 'ENTERED',
  TP1_HIT: 'TP1_HIT',
  TP2_HIT: 'TP2_HIT',
  SL_HIT: 'SL_HIT',
  EXPIRED: 'EXPIRED',
  INVALIDATED: 'INVALIDATED'
};

// 结果类型
const RESULT_TYPE = {
  WIN: 'WIN',
  LOSS: 'LOSS',
  BREAKEVEN: 'BREAKEVEN',
  EXPIRED: 'EXPIRED',
  INVALID: 'INVALID'
};

function loadActiveSignals() {
  try {
    if (fs.existsSync(ACTIVE_SIGNALS_FILE)) {
      return JSON.parse(fs.readFileSync(ACTIVE_SIGNALS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('[SignalLifecycle] Error loading active signals:', error.message);
  }
  return {};
}

function saveActiveSignals(signals) {
  try {
    fs.writeFileSync(ACTIVE_SIGNALS_FILE, JSON.stringify(signals, null, 2));
  } catch (error) {
    console.error('[SignalLifecycle] Error saving active signals:', error.message);
  }
}

function loadHistory() {
  try {
    if (fs.existsSync(SIGNALS_HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(SIGNALS_HISTORY_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('[SignalLifecycle] Error loading history:', error.message);
  }
  return { records: [], stats: {} };
}

function saveHistory(history) {
  try {
    fs.writeFileSync(SIGNALS_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (error) {
    console.error('[SignalLifecycle] Error saving history:', error.message);
  }
}

function addSignal(signal) {
  const activeSignals = loadActiveSignals();

  activeSignals[signal.id] = {
    ...signal,
    status: SIGNAL_STATUS.ACTIVE,
    created_at: Date.now(),
    entered_at: null,
    closed_at: null,
    result: null,
    pnl: null,
    pnl_percent: null,
    exit_price: null,
    exit_reason: null
  };

  saveActiveSignals(activeSignals);
  console.log(`[SignalLifecycle] Added signal: ${signal.id}`);
  return activeSignals[signal.id];
}

function markEntered(signalId, entryPrice) {
  const activeSignals = loadActiveSignals();

  if (activeSignals[signalId]) {
    activeSignals[signalId].status = SIGNAL_STATUS.ENTERED;
    activeSignals[signalId].entry_price_actual = entryPrice;
    activeSignals[signalId].entered_at = Date.now();
    saveActiveSignals(activeSignals);
    console.log(`[SignalLifecycle] Signal entered: ${signalId} at ${entryPrice}`);
    return true;
  }

  return false;
}

function closeSignal(signalId, exitPrice, reason) {
  const activeSignals = loadActiveSignals();
  const history = loadHistory();

  const signal = activeSignals[signalId];
  if (!signal) {
    console.log(`[SignalLifecycle] Signal not found: ${signalId}`);
    return null;
  }

  const entryPrice = signal.entry_price_actual || signal.entry_price;
  let pnl = 0;
  let pnlPercent = 0;
  let result = RESULT_TYPE.EXPIRED;

  if (signal.direction === 'LONG') {
    pnl = exitPrice - entryPrice;
    pnlPercent = (pnl / entryPrice) * 100;
  } else {
    pnl = entryPrice - exitPrice;
    pnlPercent = (pnl / entryPrice) * 100;
  }

  if (reason === 'TP1' || reason === 'TP2') {
    result = RESULT_TYPE.WIN;
  } else if (reason === 'SL') {
    result = RESULT_TYPE.LOSS;
  } else if (Math.abs(pnlPercent) < 0.1) {
    result = RESULT_TYPE.BREAKEVEN;
  }

  signal.status = reason === 'TP1' ? SIGNAL_STATUS.TP1_HIT : 
                  reason === 'TP2' ? SIGNAL_STATUS.TP2_HIT :
                  reason === 'SL' ? SIGNAL_STATUS.SL_HIT : SIGNAL_STATUS.EXPIRED;
  signal.closed_at = Date.now();
  signal.exit_price = exitPrice;
  signal.exit_reason = reason;
  signal.pnl = pnl;
  signal.pnl_percent = pnlPercent;
  signal.result = result;

  history.records.push({ ...signal, closed_at: Date.now() });

  delete activeSignals[signalId];

  saveActiveSignals(activeSignals);
  saveHistory(history);

  console.log(`[SignalLifecycle] Signal closed: ${signalId}, Result: ${result}, PnL: ${pnlPercent.toFixed(2)}%`);

  return signal;
}

function checkSignalTriggers(symbol, currentPrice) {
  const activeSignals = loadActiveSignals();
  const triggered = [];

  for (const [id, signal] of Object.entries(activeSignals)) {
    if (signal.symbol !== symbol) continue;

    const { direction, sl, tp1, tp2, status } = signal;

    if (status !== SIGNAL_STATUS.ENTERED) continue;

    if (direction === 'LONG') {
      if (currentPrice <= sl) {
        triggered.push({ signal, exitPrice: currentPrice, reason: 'SL' });
      } else if (currentPrice >= tp2) {
        triggered.push({ signal, exitPrice: currentPrice, reason: 'TP2' });
      } else if (currentPrice >= tp1) {
        triggered.push({ signal, exitPrice: currentPrice, reason: 'TP1' });
      }
    } else {
      if (currentPrice >= sl) {
        triggered.push({ signal, exitPrice: currentPrice, reason: 'SL' });
      } else if (currentPrice <= tp2) {
        triggered.push({ signal, exitPrice: currentPrice, reason: 'TP2' });
      } else if (currentPrice <= tp1) {
        triggered.push({ signal, exitPrice: currentPrice, reason: 'TP1' });
      }
    }
  }

  return triggered;
}

function processPriceUpdate(symbol, currentPrice) {
  const triggered = checkSignalTriggers(symbol, currentPrice);
  const results = [];

  for (const { signal, exitPrice, reason } of triggered) {
    const result = closeSignal(signal.id, exitPrice, reason);
    if (result) {
      results.push(result);
    }
  }

  return results;
}

function getWinRateStats(period = 'all') {
  const history = loadHistory();
  const records = history.records || [];

  let filteredRecords = records;
  if (period !== 'all') {
    const now = Date.now();
    const periodMs = {
      '24h': 24 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000
    }[period] || 24 * 60 * 60 * 1000;

    filteredRecords = records.filter(r => (r.closed_at || r.created_at) > now - periodMs);
  }

  const total = filteredRecords.length;
  const wins = filteredRecords.filter(r => r.result === RESULT_TYPE.WIN).length;
  const losses = filteredRecords.filter(r => r.result === RESULT_TYPE.LOSS).length;
  const breakeven = filteredRecords.filter(r => r.result === RESULT_TYPE.BREAKEVEN).length;
  const winRate = total > 0 ? (wins / total) * 100 : 0;

  const byRating = { S: { total: 0, win: 0, loss: 0, winRate: 0 },
                     A: { total: 0, win: 0, loss: 0, winRate: 0 },
                     B: { total: 0, win: 0, loss: 0, winRate: 0 },
                     C: { total: 0, win: 0, loss: 0, winRate: 0 } };

  for (const record of filteredRecords) {
    const rating = record.rating || 'C';
    if (byRating[rating]) {
      byRating[rating].total++;
      if (record.result === RESULT_TYPE.WIN) byRating[rating].win++;
      else if (record.result === RESULT_TYPE.LOSS) byRating[rating].loss++;
    }
  }

  for (const rating of Object.keys(byRating)) {
    const r = byRating[rating];
    r.winRate = r.total > 0 ? (r.win / r.total) * 100 : 0;
  }

  const totalPnL = filteredRecords.reduce((sum, r) => sum + (r.pnl_percent || 0), 0);
  const avgPnL = total > 0 ? totalPnL / total : 0;

  return {
    period,
    total,
    win: wins,
    loss: losses,
    breakeven,
    winRate,
    avgPnL,
    byRating,
    recentTrades: filteredRecords.slice(-10).reverse()
  };
}

function getActiveSignals() {
  return loadActiveSignals();
}

function getHistory() {
  return loadHistory();
}

module.exports = {
  SIGNAL_STATUS,
  RESULT_TYPE,
  addSignal,
  markEntered,
  closeSignal,
  checkSignalTriggers,
  processPriceUpdate,
  getWinRateStats,
  getActiveSignals,
  getHistory
};
