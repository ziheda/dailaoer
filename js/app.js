const config = require('./config');

const canvas = wx.createCanvas();
const ctx = canvas.getContext('2d');
const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
const width = windowInfo.windowWidth;
const height = windowInfo.windowHeight;
const dpr = windowInfo.pixelRatio || 1;

canvas.width = width * dpr;
canvas.height = height * dpr;
ctx.scale(dpr, dpr);

let socket = null;
let connecting = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let state = null;
let session = null;
let connected = false;
let statusText = '正在连接服务器……';
let selected = new Set();
let buttons = [];
let cardAreas = [];
let logs = ['请先创建房间，另外两名玩家输入房间号加入。'];
let exitAfterRoom = false;

const storedName = wx.getStorageSync('playerName');
let playerName = storedName || `玩家${Math.floor(Math.random() * 900 + 100)}`;
wx.setStorageSync('playerName', playerName);

const rankText = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const suitText = { club: '♣', diamond: '♦', heart: '♥', spade: '♠' };

function addLog(text) {
  logs.unshift(String(text));
  logs = logs.slice(0, 5);
  render();
}

function cardText(card) {
  if (!card) return '暗牌';
  if (card.isJoker || card.suit === 'joker') {
    return card.id === 'joker-big' ? '大王' : '小王';
  }
  return `${suitText[card.suit] || ''}${rankText[card.rank] || card.rank}`;
}

function phaseText(phase) {
  return ({
    WAITING: '等待玩家',
    SELECTING: '选择两张牌',
    REVEALING: '展示本轮牌面',
    ROUND_CONFIRM: '等待玩家确认',
    FINISHED: '大回合结束'
  })[phase] || phase || '-';
}

function secondsRemaining(deadline) {
  if (!deadline) return 0;
  return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

function playerStatus(player) {
  if (!state) return '';
  if (!player.connected) return '已断线';
  if (state.phase === 'WAITING') return player.ready ? '已准备' : '未准备';
  if (state.phase === 'SELECTING') {
    return (state.selectedPlayerIds || []).includes(player.id) ? '已选好' : '待选牌';
  }
  if (state.phase === 'REVEALING') return '正在亮牌';
  if (state.phase === 'ROUND_CONFIRM') {
    return (state.confirmedPlayerIds || []).includes(player.id) ? '已确认' : '待确认';
  }
  if (state.phase === 'FINISHED') {
    return (state.replayPlayerIds || []).includes(player.id) ? '再来一回合' : '等待选择';
  }
  return '在线';
}

function send(payload) {
  if (!socket || !connected) {
    addLog('服务器尚未连接');
    return;
  }
  socket.send({ data: JSON.stringify(payload) });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 2000);
}

async function connect() {
  if (connecting || connected) return;
  connecting = true;
  clearTimeout(reconnectTimer);
  connected = false;
  statusText = '正在连接微信云托管……';
  render();

  try {
    if (!wx.cloud || typeof wx.cloud.connectContainer !== 'function') {
      throw new Error('当前微信基础库不支持云托管');
    }

    wx.cloud.init({ env: config.envId });
    const result = await wx.cloud.connectContainer({
      service: config.serviceName,
      path: config.socketPath
    });
    socket = result.socketTask;
    if (!socket) throw new Error('未取得云托管连接');
  } catch (error) {
    connecting = false;
    socket = null;
    statusText = `连接失败：${error.errMsg || error.message || '未知错误'}`;
    render();
    scheduleReconnect();
    return;
  }

  socket.onOpen(() => {
    connecting = false;
    connected = true;
    statusText = '服务器已连接';
    const token = wx.getStorageSync('gameSessionToken');
    if (token) send({ type: 'resume', token, protocolVersion: 2 });
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => send({ type: 'heartbeat' }), 10000);
    render();
  });
  socket.onMessage((event) => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch (error) {
      addLog(`消息解析失败：${error.message}`);
    }
  });
  socket.onError((error) => {
    connecting = false;
    connected = false;
    statusText = `连接失败：${error.errMsg || '请查看调试器'}`;
    render();
    scheduleReconnect();
  });
  socket.onClose(() => {
    connecting = false;
    connected = false;
    socket = null;
    clearInterval(heartbeatTimer);
    statusText = '连接断开，2秒后重试';
    render();
    scheduleReconnect();
  });
}

function handleMessage(message) {
  if (message.type === 'session') {
    session = message;
    wx.setStorageSync('gameSessionToken', message.token);
    addLog(`已进入房间 ${message.roomCode}`);
  } else if (message.type === 'state') {
    const previousRound = state && state.roundIndex;
    state = message;
    if (message.phase === 'SELECTING' && previousRound !== message.roundIndex) selected.clear();
    render();
  } else if (message.type === 'round_result') {
    const lines = message.players.map((player) => {
      const sign = player.delta >= 0 ? '+' : '';
      const automatic = (message.autoSelectedPlayerIds || []).includes(player.id)
        ? '（超时自动选牌）'
        : '';
      return `${player.name}${automatic} ${player.evaluation.name} ${sign}${player.delta}`;
    });
    selected.clear();
    addLog(`第${message.roundIndex + 1}轮：${lines.join('；')}`);
  } else if (message.type === 'room_exited') {
    wx.removeStorageSync('gameSessionToken');
    session = null;
    state = null;
    selected.clear();
    addLog('已退出房间');
    if (exitAfterRoom && typeof wx.exitMiniProgram === 'function') {
      wx.exitMiniProgram({});
    }
  } else if (message.type === 'error') {
    addLog(`错误：${message.message}`);
    if (String(message.message).includes('恢复')) {
      wx.removeStorageSync('gameSessionToken');
      session = null;
    }
  }
}

function roundedRect(x, y, w, h, radius, fill, stroke) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawText(text, x, y, size, color, align) {
  ctx.font = `${size}px sans-serif`;
  ctx.fillStyle = color || '#ffffff';
  ctx.textAlign = align || 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(text), x, y);
}

function addButton(id, text, x, y, w, h, enabled) {
  roundedRect(x, y, w, h, 9, enabled ? '#f4c64f' : '#6f806f');
  drawText(text, x + w / 2, y + h / 2, 15, enabled ? '#173426' : '#d8ded8', 'center');
  buttons.push({ id, x, y, w, h, enabled });
}

function drawCard(card, x, y, w, h, isSelected) {
  const red = card && (card.suit === 'heart' || card.suit === 'diamond');
  roundedRect(x, y, w, h, 7, '#ffffff', isSelected ? '#ffd34d' : '#d7e0da');
  if (isSelected) {
    ctx.strokeStyle = '#ffd34d';
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  drawText(cardText(card), x + w / 2, y + h / 2, cardText(card).length > 2 ? 14 : 18, red ? '#cc3544' : '#18231d', 'center');
}

function render() {
  buttons = [];
  cardAreas = [];
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b4b35';
  ctx.fillRect(0, 0, width, height);

  const margin = 14;
  drawText('逮老二 · 三人联机', margin, 30, 23, '#ffffff');
  drawText(statusText, margin, 57, 12, connected ? '#c7ffd9' : '#ffe09b');

  roundedRect(margin, 78, width - margin * 2, 82, 12, 'rgba(0,0,0,0.20)');
  drawText(`昵称：${playerName}`, margin + 12, 96, 14, '#ffffff');
  drawText(`房间：${state ? state.roomCode : (session ? session.roomCode : '-')}`, margin + 12, 121, 14, '#ffffff');
  const selectionCountdown = state && state.phase === 'SELECTING'
    ? ` · ${secondsRemaining(state.selectionEndsAt)}秒`
    : '';
  drawText(`阶段：${phaseText(state && state.phase)}${selectionCountdown}`, margin + 12, 146, 14, '#ffffff');

  const buttonY = 173;
  const gap = 7;
  const buttonW = (width - margin * 2 - gap * 2) / 3;
  addButton('create', '创建房间', margin, buttonY, buttonW, 42, connected && !session);
  addButton('join', '加入房间', margin + buttonW + gap, buttonY, buttonW, 42, connected && !session);
  addButton('ready', '准备', margin + (buttonW + gap) * 2, buttonY, buttonW, 42, !!state && state.phase === 'WAITING');

  const playersY = 226;
  drawText('玩家与分数', margin, playersY, 15, '#ffe09b');
  const playerBoxY = playersY + 14;
  const playerW = (width - margin * 2 - gap * 2) / 3;
  const players = state ? state.players : [];
  for (let index = 0; index < 3; index += 1) {
    const player = players[index];
    const x = margin + index * (playerW + gap);
    roundedRect(x, playerBoxY, playerW, 66, 9, 'rgba(255,255,255,0.10)');
    drawText(player ? player.name : '等待加入', x + playerW / 2, playerBoxY + 17, 13, '#ffffff', 'center');
    drawText(player ? `${player.score}分 · ${player.handCount}张` : '-', x + playerW / 2, playerBoxY + 39, 12, '#cde5d6', 'center');
    drawText(player ? playerStatus(player) : '', x + playerW / 2, playerBoxY + 57, 11, '#ffe09b', 'center');
  }

  const publicY = 332;
  const revealedHands = state ? (state.revealedHands || []) : [];
  if (state && state.phase === 'REVEALING' && revealedHands.length) {
    drawText(`本轮亮牌 · ${secondsRemaining(state.revealEndsAt)}秒`, margin, publicY, 15, '#ffe09b');
    const revealGap = 6;
    const revealGroupW = (width - margin * 2 - revealGap * 2) / 3;
    revealedHands.forEach((player, playerIndex) => {
      const groupX = margin + playerIndex * (revealGroupW + revealGap);
      drawText(player.name, groupX + revealGroupW / 2, publicY + 18, 11, '#ffffff', 'center');
      const miniGap = 2;
      const miniW = Math.min(32, (revealGroupW - miniGap * 2) / 3);
      const cardsWidth = miniW * 3 + miniGap * 2;
      const cardsX = groupX + (revealGroupW - cardsWidth) / 2;
      player.cards.forEach((card, cardIndex) => {
        drawCard(card, cardsX + cardIndex * (miniW + miniGap), publicY + 29, miniW, 48, false);
      });
      const sign = player.delta >= 0 ? '+' : '';
      drawText(`${player.evaluationName} ${sign}${player.delta}`, groupX + revealGroupW / 2, publicY + 84, 10, '#ffe09b', 'center');
    });
  } else {
    const publicCards = state ? state.publicCards : [];
    drawText(`剩余公共牌 · 第${state && state.roundIndex < 5 ? state.roundIndex + 1 : '-'}轮`, margin, publicY, 15, '#ffe09b');
    if (publicCards.length === 0) {
      drawText('公共牌已全部使用', width / 2, publicY + 48, 14, '#cde5d6', 'center');
    } else {
      const publicW = 55;
      const publicGap = 8;
      const publicStart = (width - (publicW * publicCards.length + publicGap * (publicCards.length - 1))) / 2;
      publicCards.forEach((card, index) => {
        drawCard(card, publicStart + index * (publicW + publicGap), publicY + 14, publicW, 66, false);
      });
    }
  }

  const handY = 424;
  const handTitle = state && state.phase === 'SELECTING'
    ? '我的手牌（点两张牌）'
    : '我的剩余手牌';
  drawText(handTitle, margin, handY, 15, '#ffe09b');
  const hand = state ? state.yourHand : [];
  const cardGap = 5;
  const cardW = Math.min(51, (width - margin * 2 - cardGap * 6) / 7);
  const handStart = (width - (cardW * Math.max(hand.length, 1) + cardGap * Math.max(hand.length - 1, 0))) / 2;
  hand.forEach((card, index) => {
    const x = handStart + index * (cardW + cardGap);
    const chosen = selected.has(card.id);
    const y = handY + 20 - (chosen ? 7 : 0);
    drawCard(card, x, y, cardW, 70, chosen);
    cardAreas.push({ card, x, y, w: cardW, h: 70 });
  });

  const alreadySelected = !!state && (state.selectedPlayerIds || []).includes(state.yourPlayerId);
  const canSelect = !!state && state.phase === 'SELECTING' && state.roundIndex <= 3 && selected.size === 2 && !alreadySelected;
  if (state && state.phase === 'ROUND_CONFIRM') {
    const alreadyConfirmed = (state.confirmedPlayerIds || []).includes(state.yourPlayerId);
    const confirmText = state.roundIndex <= 2 ? '确认并摸两张牌' : '确认进入最后一轮';
    addButton('confirm', alreadyConfirmed ? '等待其他玩家确认' : confirmText, margin, 526, width - margin * 2, 43, !alreadyConfirmed);
  } else if (state && state.phase === 'FINISHED') {
    const replayed = (state.replayPlayerIds || []).includes(state.yourPlayerId);
    const finishButtonW = (width - margin * 2 - gap) / 2;
    addButton('play_again', replayed ? '等待其他玩家' : '再来一回合', margin, 526, finishButtonW, 43, !replayed);
    addButton('exit', '退出游戏', margin + finishButtonW + gap, 526, finishButtonW, 43, true);
  } else {
    const selectText = state && state.phase === 'REVEALING'
      ? '正在展示本轮牌面'
      : (alreadySelected ? '等待其他玩家' : '锁定这两张牌');
    addButton('select', selectText, margin, 526, width - margin * 2, 43, canSelect);
  }

  roundedRect(margin, 580, width - margin * 2, Math.max(80, height - 594), 10, 'rgba(0,0,0,0.20)');
  drawText('牌局记录', margin + 10, 598, 13, '#ffe09b');
  logs.slice(0, Math.max(2, Math.floor((height - 620) / 20))).forEach((line, index) => {
    const shortLine = line.length > 38 ? `${line.slice(0, 38)}…` : line;
    drawText(shortLine, margin + 10, 622 + index * 20, 11, '#e7f3ea');
  });
}

function pointInside(point, area) {
  return point.x >= area.x && point.x <= area.x + area.w && point.y >= area.y && point.y <= area.y + area.h;
}

function askPlayerName(next) {
  wx.showModal({
    title: '玩家昵称',
    content: playerName,
    editable: true,
    placeholderText: '输入昵称',
    success(result) {
      if (!result.confirm) return;
      const value = String(result.content || playerName).trim().slice(0, 12) || playerName;
      playerName = value;
      wx.setStorageSync('playerName', value);
      next();
      render();
    }
  });
}

function handleButton(id) {
  if (id === 'create') {
    askPlayerName(() => send({ type: 'create_room', name: playerName, protocolVersion: 2 }));
  } else if (id === 'join') {
    askPlayerName(() => {
      wx.showModal({
        title: '加入房间',
        content: '',
        editable: true,
        placeholderText: '输入6位房间号',
        success(result) {
          if (!result.confirm) return;
          const roomCode = String(result.content || '').trim();
          if (!/^\d{6}$/.test(roomCode)) {
            wx.showToast({ title: '请输入6位房间号', icon: 'none' });
            return;
          }
          send({ type: 'join_room', name: playerName, roomCode, protocolVersion: 2 });
        }
      });
    });
  } else if (id === 'ready') {
    send({ type: 'ready' });
  } else if (id === 'select') {
    send({ type: 'select_cards', cardIds: Array.from(selected) });
  } else if (id === 'confirm') {
    send({ type: 'confirm_round' });
  } else if (id === 'play_again') {
    send({ type: 'play_again' });
  } else if (id === 'exit') {
    wx.showModal({
      title: '确认退出游戏',
      content: '退出后将离开当前房间，确定要退出吗？',
      confirmText: '确认退出',
      cancelText: '继续游戏',
      success(result) {
        if (!result.confirm) return;
        exitAfterRoom = true;
        send({ type: 'exit_room' });
      }
    });
  }
}

wx.onTouchEnd((event) => {
  const touch = event.changedTouches && event.changedTouches[0];
  if (!touch) return;
  const point = { x: touch.clientX, y: touch.clientY };

  const button = buttons.find((item) => item.enabled && pointInside(point, item));
  if (button) {
    handleButton(button.id);
    return;
  }

  const cardArea = cardAreas.find((item) => pointInside(point, item));
  if (!cardArea || !state || state.phase !== 'SELECTING') return;
  if ((state.selectedPlayerIds || []).includes(state.yourPlayerId)) return;
  if (selected.has(cardArea.card.id)) selected.delete(cardArea.card.id);
  else if (selected.size < 2) selected.add(cardArea.card.id);
  render();
});

render();
connect();
setInterval(render, 500);
