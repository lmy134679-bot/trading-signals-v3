
// 测试：手动关闭信号
app.post('/api/signals/test-close', (req, res) => {
  try {
    const { signalId, exitPrice, reason } = req.body;
    const result = closeSignal(signalId, exitPrice, reason);
    if (result) {
      res.json({
        success: true,
        message: `Signal ${signalId} closed`,
        result
      });
    } else {
      res.status(404).json({ success: false, error: 'Signal not found' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
