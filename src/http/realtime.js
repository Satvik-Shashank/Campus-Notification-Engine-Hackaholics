'use strict';

const { WebSocketServer } = require('ws');
const { verifyJwt } = require('./auth');

const MAX_SOCKETS_PER_SUBSCRIBER = 5;
const HEARTBEAT_MS = 30000;

/**
 * WebSocket gateway for real-time in-app delivery (ARCHITECTURE "WebSocket Gateway").
 *   GET /ws?token=<subscriber JWT>  ->  pushes {"type":"notification", ...} for that subscriber only.
 * Fire-and-forget by design: the message is already stored, so a missed push only delays it until the
 * client's next fetch. The socket is closed when the token expires.
 */
function attachRealtime(server, engine) {
  const { ctx } = engine;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const rooms = new Map(); // subscriber external id -> Set<WebSocket>

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const claims = verifyJwt(url.searchParams.get('token'), ctx.config.jwtSecret, { now: ctx.clock.now() });
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!claims || claims.org !== ctx.config.organizationId || !ctx.subscribers.byExternal(claims.sub)) return reject(401, 'Unauthorized');
    const room = rooms.get(claims.sub) || new Set();
    if (room.size >= MAX_SOCKETS_PER_SUBSCRIBER) return reject(429, 'Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => {
      room.add(ws);
      rooms.set(claims.sub, room);
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      const expiry = setTimeout(() => ws.close(4001, 'token expired'), Math.max(0, Math.min(claims.exp * 1000 - ctx.clock.now(), 2 ** 31 - 1)));
      ws.on('close', () => {
        clearTimeout(expiry);
        room.delete(ws);
        if (room.size === 0) rooms.delete(claims.sub);
      });
      ws.on('message', () => {}); // clients do not send anything meaningful
      ws.send(JSON.stringify({ type: 'hello', subscriberId: claims.sub }));
    });
    return undefined;
  });

  const onInApp = (m) => {
    const room = rooms.get(m.subscriberId);
    if (!room) return;
    const frame = JSON.stringify({ type: 'notification', notificationId: `notif_${m.notificationId}`, subject: m.subject, content: m.body });
    for (const ws of room) if (ws.readyState === ws.OPEN) ws.send(frame);
  };
  ctx.bus.on('in-app', onInApp);

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    connections: () => wss.clients.size,
    close() {
      clearInterval(heartbeat);
      ctx.bus.off('in-app', onInApp);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}

module.exports = { attachRealtime };
