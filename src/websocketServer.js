/**
 * WebSocket服务器
 */

const WebSocket = require('ws');

let wss = null;

function initWebSocketServer(server) {
  wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    console.log('[WebSocket] Client connected');

    ws.on('close', () => {
      console.log('[WebSocket] Client disconnected');
    });
  });

  console.log('[WebSocket] Server initialized');
}

function broadcastSignalUpdate(data) {
  if (!wss) return;

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

module.exports = {
  initWebSocketServer,
  broadcastSignalUpdate
};
