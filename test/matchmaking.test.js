import assert from 'node:assert/strict';
import WebSocket from 'ws';

const url = process.env.TEST_WS_URL || 'ws://127.0.0.1:3101/ws';

class TestClient {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.waiters = [];
  }

  async connect() {
    this.ws = new WebSocket(url);
    this.ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    await this.waitFor((message) => message.type === 'hello');
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  waitFor(predicate, timeoutMs = 5000) {
    const existing = [...this.messages].reverse().find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`${this.name} 等待服务器消息超时`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  clear() {
    this.messages = [];
  }

  close() {
    this.ws?.close();
  }
}

async function statesFor(clients, phase, roundIndex) {
  return Promise.all(clients.map((client) => client.waitFor(
    (message) => message.type === 'state' && message.phase === phase && message.roundIndex === roundIndex,
  )));
}

async function enterRandomMatch(clients) {
  clients.forEach((client) => client.send({
    type: 'join_matchmaking',
    name: client.name,
    coinBalance: 600,
    protocolVersion: 3,
  }));
  const sessions = await Promise.all(clients.map((client) => client.waitFor(
    (message) => message.type === 'session' && message.mode === 'MATCHMAKING',
  )));
  const states = await statesFor(clients, 'SELECTING', 0);
  assert.equal(new Set(sessions.map((session) => session.roomCode)).size, 1);
  assert.equal(states.every((state) => state.mode === 'MATCHMAKING' && state.stake === 100), true);
  return states;
}

const clients = [new TestClient('随机甲'), new TestClient('随机乙'), new TestClient('随机丙')];

try {
  await Promise.all(clients.map((client) => client.connect()));
  let selectingStates = await enterRandomMatch(clients);
  const firstMatchId = selectingStates[0].matchId;

  for (let roundIndex = 0; roundIndex < 4; roundIndex += 1) {
    if (roundIndex > 0) selectingStates = await statesFor(clients, 'SELECTING', roundIndex);
    selectingStates.forEach((state, index) => clients[index].send({
      type: 'select_cards',
      cardIds: state.yourHand.slice(0, 2).map((card) => card.id),
    }));
    await Promise.all(clients.map((client) => client.waitFor(
      (message) => message.type === 'round_result' && message.roundIndex === roundIndex,
    )));
    await statesFor(clients, 'ROUND_CONFIRM', roundIndex);
    clients.forEach((client) => client.send({ type: 'confirm_round' }));
  }

  await Promise.all(clients.map((client) => client.waitFor(
    (message) => message.type === 'round_result' && message.roundIndex === 4,
  )));
  const settlements = await Promise.all(clients.map((client) => client.waitFor(
    (message) => message.type === 'coin_settlement' && message.matchId === firstMatchId,
  )));
  await statesFor(clients, 'FINISHED', 4);
  const results = settlements[0].players;
  assert.equal(results.reduce((sum, player) => sum + player.delta, 0), 0);
  assert.equal(results.reduce((sum, player) => sum + player.payout, 0), 300);
  assert.equal(results.every((player) => player.delta === player.payout - 100), true);

  clients[0].send({ type: 'exit_room' });
  await Promise.all(clients.map((client) => client.waitFor((message) => message.type === 'match_closed')));
  clients.forEach((client) => client.clear());

  const nextStates = await enterRandomMatch(clients);
  assert.notEqual(nextStates[0].matchId, firstMatchId);
  clients[0].send({ type: 'exit_room' });
  const forfeits = await Promise.all(clients.map((client) => client.waitFor(
    (message) => message.type === 'coin_settlement' && message.reason === 'forfeit',
  )));
  const deltas = forfeits[0].players.map((player) => player.delta).sort((a, b) => a - b);
  assert.deepEqual(deltas, [-100, 50, 50]);
  await Promise.all(clients.map((client) => client.waitFor((message) => message.type === 'match_closed')));
  console.log('随机匹配测试通过：三人自动开局、零和牌豆结算和中途弃赛均正常');
} finally {
  clients.forEach((client) => client.close());
}
