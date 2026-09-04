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
const roomTimers = new Map();
const matchmakingQueue = [];
const settledMatchIds = new Set();
const MATCH_STAKE = 100;

function json(ws, payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
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

function roomSessions(room) {
  return [...sessions.entries()].filter(([, session]) => session.roomCode === room.code);
}

function removeFromMatchmakingQueue(ws) {
  const index = matchmakingQueue.findIndex((entry) => entry.ws === ws);
  if (index < 0) return false;
  matchmakingQueue.splice(index, 1);
  notifyMatchmakingQueue();
  return true;
}

function notifyMatchmakingQueue() {
  matchmakingQueue.forEach((entry, index) => {
    json(entry.ws, {
      type: 'matchmaking',
      status: 'waiting',
      waitingCount: matchmakingQueue.length,
      queuePosition: index + 1,
      requiredPlayers: 3,
      stake: MATCH_STAKE,
    });
  });
}

function makeCompletedCoinSettlement(room) {
  const sorted = [...room.players].sort((a, b) => b.score - a.score);
  const payoutsById = new Map();
  const payoutSlots = [MATCH_STAKE * 2, MATCH_STAKE, 0];
  let index = 0;
  while (index < sorted.length) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].score === sorted[index].score) end += 1;
    const totalPayout = payoutSlots.slice(index, end).reduce((sum, value) => sum + value, 0);
    const sharedPayout = totalPayout / (end - index);
    for (let cursor = index; cursor < end; cursor += 1) {
      payoutsById.set(sorted[cursor].id, { payout: sharedPayout, rank: index + 1 });
    }
    index = end;
  }
  return room.players.map((player) => {
    const result = payoutsById.get(player.id);
    return {
      playerId: player.id,
      playerName: player.name,
      score: player.score,
      rank: result.rank,
      payout: result.payout,
      delta: result.payout - MATCH_STAKE,
    };
  });
}

function sendCoinSettlement(room, results, reason = 'completed') {
  if (!room.matchId || settledMatchIds.has(room.matchId)) return;
  settledMatchIds.add(room.matchId);
  const payload = {
    type: 'coin_settlement',
    matchId: room.matchId,
    roomCode: room.code,
    stake: MATCH_STAKE,
    reason,
    players: results,
  };
  broadcast(room, payload);
}

function settleCompletedMatchmakingRoom(room) {
  if (room.mode !== 'MATCHMAKING' || room.phase !== 'FINISHED') return;
  sendCoinSettlement(room, makeCompletedCoinSettlement(room));
}

function closeMatchmakingRoom(room, exitingPlayerId) {
  const exitingPlayer = room.getPlayer(exitingPlayerId);
  const interrupted = !['WAITING', 'FINISHED'].includes(room.phase);
  if (interrupted && room.players.length === 3) {
    const results = room.players.map((player) => ({
      playerId: player.id,
      playerName: player.name,
      score: player.score,
      rank: player.id === exitingPlayerId ? 3 : 1,
      payout: player.id === exitingPlayerId ? 0 : MATCH_STAKE * 1.5,
      delta: player.id === exitingPlayerId ? -MATCH_STAKE : MATCH_STAKE * 0.5,
    }));
    sendCoinSettlement(room, results, 'forfeit');
  }

  clearRoomTimer(room.code);
  for (const [token, session] of roomSessions(room)) {
    json(session.ws, {
      type: 'match_closed',
      reason: interrupted
        ? `${exitingPlayer?.name || '一名玩家'}中途退出，按弃赛结算，本场匹配已结束`
        : '本场随机匹配已结束，请返回首页重新匹配',
    });
    if (session.ws) session.ws.sessionToken = null;
    sessions.delete(token);
  }
  rooms.delete(room.code);
}

function tryStartMatchmaking() {
  for (let index = matchmakingQueue.length - 1; index >= 0; index -= 1) {
    if (matchmakingQueue[index].ws.readyState !== WebSocket.OPEN) matchmakingQueue.splice(index, 1);
  }
  while (matchmakingQueue.length >= 3) {
    const entries = matchmakingQueue.splice(0, 3);
    const code = createRoomCode();
    const room = new GameRoom(code, { mode: 'MATCHMAKING', stake: MATCH_STAKE });
    rooms.set(code, room);
    const players = entries.map((entry) => room.addPlayer(entry.name));
    entries.forEach((entry, index) => {
      createSession(entry.ws, room, players[index], entry.protocolVersion);
    });
    room.start();
    broadcast(room, { type: 'match_found', roomCode: code, stake: MATCH_STAKE });
    broadcastState(room);
    scheduleRoomPhase(room);
  }
  notifyMatchmakingQueue();
}

function roomHasLegacyClient(room) {
  return room.players.some((player) => {
    const session = [...sessions.values()].find(
      (item) => item.roomCode === room.code && item.playerId === player.id,
    );
    return (session?.protocolVersion || 1) < 2;
  });
}

function clearRoomTimer(roomCode) {
  const timer = roomTimers.get(roomCode);
  if (timer) clearTimeout(timer);
  roomTimers.delete(roomCode);
}

function scheduleRoomPhase(room) {
  clearRoomTimer(room.code);
  let deadline = null;
  let action = null;

  if (room.phase === 'SELECTING' && room.selectionEndsAt) {
    deadline = room.selectionEndsAt;
    action = () => {
      if (room.phase !== 'SELECTING') return;
      const result = room.autoSelectMissing();
      if (result) broadcast(room, result);
      broadcastState(room);
      scheduleRoomPhase(room);
    };
  } else if (room.phase === 'REVEALING' && room.revealEndsAt) {
    deadline = room.revealEndsAt;
    action = () => {
      if (room.phase !== 'REVEALING') return;
      room.finishReveal();
      let result = null;
      // 兼容尚未更新“确认摸牌”按钮的旧版小游戏。
      if (room.phase === 'ROUND_CONFIRM' && roomHasLegacyClient(room)) {
        for (const player of room.players) result = room.confirmRound(player.id) || result;
        if (result) broadcast(room, result);
      }
      settleCompletedMatchmakingRoom(room);
      broadcastState(room);
      scheduleRoomPhase(room);
    };
  }

  if (!deadline || !action) return;
  const timer = setTimeout(() => {
    roomTimers.delete(room.code);
    try {
      action();
    } catch (error) {
      broadcast(room, { type: 'error', message: error.message || '服务器计时任务错误' });
    }
  }, Math.max(0, deadline - Date.now()));
  roomTimers.set(room.code, timer);
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
    mode: room?.mode || 'FRIEND',
  });
  if (room) broadcastState(room);
}

function createSession(ws, room, player, protocolVersion = 1) {
  const token = randomUUID();
  const session = { roomCode: room.code, playerId: player.id, ws, protocolVersion };
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
      removeFromMatchmakingQueue(ws);
      const code = createRoomCode();
      const room = new GameRoom(code);
      rooms.set(code, room);
      const player = room.addPlayer(message.name);
      createSession(ws, room, player, Number(message.protocolVersion) || 1);
      break;
    }
    case 'join_room': {
      if (ws.sessionToken) throw new Error('当前已经在房间中');
      removeFromMatchmakingQueue(ws);
      const code = String(message.roomCode || '').trim();
      const room = rooms.get(code);
      if (!room) throw new Error('房间不存在');
      if (room.mode !== 'FRIEND') throw new Error('随机匹配房间不能通过房间号加入');
      const player = room.addPlayer(message.name);
      createSession(ws, room, player, Number(message.protocolVersion) || 1);
      broadcastState(room);
      break;
    }
    case 'join_matchmaking': {
      if (ws.sessionToken) throw new Error('当前已经在房间中');
      if (matchmakingQueue.some((entry) => entry.ws === ws)) {
        notifyMatchmakingQueue();
        break;
      }
      const coinBalance = Math.max(0, Number(message.coinBalance) || 0);
      if (coinBalance < MATCH_STAKE) throw new Error(`随机匹配至少需要${MATCH_STAKE}牌豆`);
      matchmakingQueue.push({
        ws,
        name: String(message.name || '').trim().slice(0, 12) || '玩家',
        protocolVersion: Number(message.protocolVersion) || 1,
      });
      tryStartMatchmaking();
      break;
    }
    case 'cancel_matchmaking': {
      removeFromMatchmakingQueue(ws);
      json(ws, { type: 'matchmaking', status: 'cancelled', waitingCount: matchmakingQueue.length });
      break;
    }
    case 'resume': {
      const token = String(message.token || '');
      const session = sessions.get(token);
      if (!session) throw new Error('无法恢复原牌局');
      session.protocolVersion = Number(message.protocolVersion) || session.protocolVersion || 1;
      attachSession(ws, token, session);
      break;
    }
    case 'ready': {
      const { session, room } = getSession(ws);
      const started = room.setReady(session.playerId);
      broadcastState(room);
      if (started) scheduleRoomPhase(room);
      break;
    }
    case 'select_cards': {
      const { session, room } = getSession(ws);
      const result = room.selectCards(session.playerId, message.cardIds);
      if (result) {
        broadcast(room, result);
        broadcastState(room);
        scheduleRoomPhase(room);
      } else {
        broadcastState(room);
      }
      break;
    }
    case 'confirm_round': {
      const { session, room } = getSession(ws);
      const result = room.confirmRound(session.playerId);
      if (result) broadcast(room, result);
      broadcastState(room);
      scheduleRoomPhase(room);
      break;
    }
    case 'play_again': {
      const { session, room } = getSession(ws);
      if (room.mode === 'MATCHMAKING') throw new Error('随机匹配结束后请返回首页重新匹配');
      const started = room.requestReplay(session.playerId);
      broadcastState(room);
      if (started) scheduleRoomPhase(room);
      break;
    }
    case 'exit_room': {
      const { session, room } = getSession(ws);
      if (room.mode === 'MATCHMAKING') {
        closeMatchmakingRoom(room, session.playerId);
        break;
      }
      const token = ws.sessionToken;
      const exitResult = room.removePlayer(session.playerId);
      sessions.delete(token);
      ws.sessionToken = null;
      clearRoomTimer(room.code);
      json(ws, { type: 'room_exited' });
      if (room.players.length === 0) rooms.delete(room.code);
      else {
        broadcast(room, {
          type: 'player_left',
          playerId: exitResult.playerId,
          playerName: exitResult.playerName,
          interrupted: exitResult.interrupted,
        });
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
    response.end(JSON.stringify({
      ok: true,
      rooms: rooms.size,
      matchmakingWaiting: matchmakingQueue.length,
      now: Date.now(),
    }));
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
    removeFromMatchmakingQueue(ws);
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
