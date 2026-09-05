import assert from 'node:assert/strict';
import WebSocket from 'ws';

const url = process.env.TEST_WS_URL || 'ws://127.0.0.1:3101/ws';
const messages = [];
const waiters = [];
const ws = new WebSocket(url);

function waitFor(predicate, timeoutMs = 6000, label = '消息') {
  const existing = [...messages].reverse().find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, timer: null };
    waiter.timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(waiter), 1);
      const tail = messages.slice(-8).map((message) =>
        `${message.type}:${message.phase || ''}:${message.roundIndex ?? ''}`,
      ).join(', ');
      reject(new Error(`等待${label}超时；最近消息：${tail}`));
    }, timeoutMs);
    waiters.push(waiter);
  });
}

ws.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  messages.push(message);
  for (const waiter of [...waiters]) {
    if (!waiter.predicate(message)) continue;
    clearTimeout(waiter.timer);
    waiters.splice(waiters.indexOf(waiter), 1);
    waiter.resolve(message);
  }
});

try {
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await waitFor((message) => message.type === 'hello');
  ws.send(JSON.stringify({
    type: 'join_matchmaking',
    name: '单人测试',
    coinBalance: 600,
    protocolVersion: 3,
  }));

  const waiting = await waitFor((message) => message.type === 'matchmaking');
  assert.ok(waiting.botFillAt > Date.now());
  const found = await waitFor((message) => message.type === 'match_found');
  assert.equal(found.botCount, 2);
  let firstState = null;
  for (let roundIndex = 0; roundIndex < 4; roundIndex += 1) {
    const state = await waitFor(
      (message) => message.type === 'state' &&
        message.phase === 'SELECTING' &&
        message.roundIndex === roundIndex,
      6000,
      `第${roundIndex + 1}轮选牌状态`,
    );
    if (!firstState) firstState = state;
    assert.equal(state.players.length, 3);
    assert.equal(state.players.filter((player) => player.isBot).length, 2);

    const botsSelected = await waitFor(
      (message) => message.type === 'state' &&
        message.phase === 'SELECTING' &&
        message.roundIndex === roundIndex &&
        message.selectedPlayerIds.length === 2,
      6000,
      `第${roundIndex + 1}轮人机选牌`,
    );
    assert.equal(
      botsSelected.players
        .filter((player) => player.isBot)
        .every((player) => botsSelected.selectedPlayerIds.includes(player.id)),
      true,
    );
    ws.send(JSON.stringify({
      type: 'select_cards',
      cardIds: state.yourHand.slice(0, 2).map((card) => card.id),
    }));
    const result = await waitFor(
      (message) => message.type === 'round_result' && message.roundIndex === roundIndex,
      6000,
      `第${roundIndex + 1}轮结果`,
    );
    assert.equal(result.players.filter((player) => player.isBot).length, 2);
    await waitFor(
      (message) => message.type === 'state' &&
        message.phase === 'ROUND_CONFIRM' &&
        message.roundIndex === roundIndex,
      6000,
      `第${roundIndex + 1}轮确认状态`,
    );
    ws.send(JSON.stringify({ type: 'confirm_round' }));
  }

  const finalResult = await waitFor(
    (message) => message.type === 'round_result' && message.roundIndex === 4,
  );
  assert.equal(finalResult.players.filter((player) => player.isBot).length, 2);
  const settlement = await waitFor(
    (message) => message.type === 'coin_settlement' && message.matchId === firstState.matchId,
  );
  assert.equal(settlement.players.reduce((sum, player) => sum + player.delta, 0), 0);
  await waitFor(
    (message) => message.type === 'state' && message.phase === 'FINISHED',
  );
  console.log('人机匹配测试通过：等待补位、身份标记、自主选牌和五轮结算均正常');
} finally {
  ws.close();
}
