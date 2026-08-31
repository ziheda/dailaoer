import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { GameRoom } from './room.js';

const PORT = Number(process.env.PORT || 3000);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INDEX_HTML = join(ROOT, 'public', 'index.html');
const rooms = new Map();
const sessions = new Map();

function json(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function createRoomCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = String(randomInt(100000, 1000000));
    if (!rooms.has(code)) return code;
  }
  throw new Error('暂时无法生成房间号');
}

function getSession(ws) {
  if (!ws.sessionToken) throw new Error('请先创建或加入房间');
  const session = sessions.get(ws.sessionToken);
  if (!session) throw new Error('登录状态已失效');
  const room = rooms.get(session.roomCode);
  if (!room) throw new Error('房间已失效');
  return { session, room };
}

function broadcastState(room) {
  for (const player of room.players) {
    const session = [...sessions.values()].find(
      (item) => item.roomCode === room.code && item.playerId === player.id,
    );
    if (session?.ws) json(session.ws, room.snapshotFor(player.id));
  }
}

function broadcast(room, payload) {
  for (const session of sessions.values()) {
    if (session.roomCode === room.code && session.ws) json(session.ws, payload);
  }
}

function attachSession(ws, token, session) {
  if (session.ws && session.ws !== ws && session.ws.readyState === WebSocket.OPEN) {
    session.ws.close(4001, '账号在其他连接恢复');
  }
  session.ws = ws;
  ws.sessionToken = token;
  const room = rooms.get(session.roomCode);
  room?.setConnected(session.playerId, true);
  json(ws, {
    type: 'session',
    token,
    roomCode: session.roomCode,
    playerId: session.playerId,
  });
  if (room) broadcastState(room);
}

function createSession(ws, room, player) {
  const token = randomUUID();
  const session = { roomCode: room.code, playerId: player.id, ws };
  sessions.set(token, session);
  attachSession(ws, token, session);
}

async function handleMessage(ws, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    throw new Error('消息不是有效JSON');
  }

  switch (message.type) {
    case 'create_room': {
      if (ws.sessionToken) throw new Error('当前已经在房间中');
      const code = createRoomCode();
      const room = new GameRoom(code);
      rooms.set(code, room);
      const player = room.addPlayer(message.name);
      createSession(ws, room, player);
      break;
    }
    case 'join_room': {
      if (ws.sessionToken) throw new Error('当前已经在房间中');
      const code = String(message.roomCode || '').trim();
      const room = rooms.get(code);
      if (!room) throw new Error('房间不存在');
      const player = room.addPlayer(message.name);
      createSession(ws, room, player);
      broadcastState(room);
      break;
    }
    case 'resume': {
      const token = String(message.token || '');
      const session = sessions.get(token);
      if (!session) throw new Error('无法恢复原牌局');
      attachSession(ws, token, session);
      break;
    }
    case 'ready': {
      const { session, room } = getSession(ws);
      room.setReady(session.playerId);
      broadcastState(room);
      break;
    }
    case 'select_cards': {
      const { session, room } = getSession(ws);
      const result = room.selectCards(session.playerId, message.cardIds);
      if (result) {
        broadcast(room, result);
        broadcastState(room);
        if (room.phase === 'FINAL_PENDING') {
          setTimeout(() => {
            if (room.phase !== 'FINAL_PENDING') return;
            const finalResult = room.settleFinalRound();
            broadcast(room, finalResult);
            broadcastState(room);
          }, 2500);
        }
      } else {
        broadcastState(room);
      }
      break;
    }
    case 'heartbeat':
      json(ws, { type: 'heartbeat_ack', now: Date.now() });
      break;
    default:
      throw new Error('未知消息类型');
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size, now: Date.now() }));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = await readFile(INDEX_HTML);
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(html);
    } catch {
      response.writeHead(500);
      response.end('Unable to load test client');
    }
    return;
  }
  response.writeHead(404);
  response.end('Not found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  json(ws, { type: 'hello', connectionId: randomUUID() });
  ws.on('message', (raw) => {
    handleMessage(ws, raw).catch((error) => {
      json(ws, { type: 'error', message: error.message || '服务器错误' });
    });
  });
  ws.on('close', () => {
    if (!ws.sessionToken) return;
    const session = sessions.get(ws.sessionToken);
    if (!session) return;
    // An older socket can close after the same player has already resumed on
    // a new socket. Only the currently attached socket may mark them offline.
    if (session.ws !== ws) return;
    session.ws = null;
    const room = rooms.get(session.roomCode);
    room?.setConnected(session.playerId, false);
    if (room) broadcastState(room);
  });
});

const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 10000);

wss.on('close', () => clearInterval(heartbeatTimer));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Game server listening on http://0.0.0.0:${PORT}`);
});
