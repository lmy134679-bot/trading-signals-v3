/**
 * 风险管理模块
 */

function getRiskAssessment(signal) {
  return {
    risk_level: 'MEDIUM',
    suggested_position_size: 0.01,
    max_loss_percent: 2
  };
}

module.exports = {
  getRiskAssessment
};
