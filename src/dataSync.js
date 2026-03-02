/**
 * 数据同步模块
 */

let dataStatus = {
  status: 'HEALTHY',
  last_update: Date.now(),
  sources: {}
};

function initDataSync() {
  console.log('[DataSync] Initialized');
}

function getDataStatus() {
  return dataStatus;
}

module.exports = {
  initDataSync,
  getDataStatus
};
