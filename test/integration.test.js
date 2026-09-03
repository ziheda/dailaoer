import assert from 'node:assert/strict';
import WebSocket from 'ws';

const url = process.env.TEST_WS_URL || 'ws://127.0.0.1:3101/ws';

class TestClient {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.waiters = [];
    this.ws = null;
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

  close() {
    this.ws?.close();
  }
}

async function waitForState(clients, phase, roundIndex) {
  return Promise.all(clients.map((client) => client.waitFor(
    (message) => message.type === 'state' && message.phase === phase && message.roundIndex === roundIndex,
  )));
}

const clients = [new TestClient('甲'), new TestClient('乙'), new TestClient('丙')];

try {
  await Promise.all(clients.map((client) => client.connect()));
  clients[0].send({ type: 'create_room', name: clients[0].name, protocolVersion: 2 });
  const creatorSession = await clients[0].waitFor((message) => message.type === 'session');
  clients[1].send({ type: 'join_room', roomCode: creatorSession.roomCode, name: clients[1].name, protocolVersion: 2 });
  clients[2].send({ type: 'join_room', roomCode: creatorSession.roomCode, name: clients[2].name, protocolVersion: 2 });
  await Promise.all(clients.slice(1).map((client) => client.waitFor((message) => message.type === 'session')));
  clients.forEach((client) => client.send({ type: 'ready' }));

  for (let roundIndex = 0; roundIndex < 4; roundIndex += 1) {
    const states = await waitForState(clients, 'SELECTING', roundIndex);
    assert.equal(states[0].publicCards.length, 4 - roundIndex);
    if (roundIndex === 3) {
      assert.equal(states.every((state) => state.publicCards[0] === null), true);
    }
    if (roundIndex === 0) {
      clients[0].send({
        type: 'select_cards',
        cardIds: states[0].yourHand.slice(0, 2).map((card) => card.id),
      });
      const selectedStates = await Promise.all(clients.map((client) => client.waitFor(
        (message) => message.type === 'state' &&
          message.phase === 'SELECTING' &&
          message.roundIndex === roundIndex &&
          message.selectedPlayerIds.includes(states[0].yourPlayerId),
      )));
      assert.equal(selectedStates.every((state) => state.selectedPlayerIds.length === 1), true);
      states.slice(1).forEach((state, index) => clients[index + 1].send({
        type: 'select_cards',
        cardIds: state.yourHand.slice(0, 2).map((card) => card.id),
      }));
    } else if (roundIndex === 1) {
      clients[0].send({
        type: 'select_cards',
        cardIds: states[0].yourHand.slice(0, 2).map((card) => card.id),
      });
    } else {
      states.forEach((state, index) => clients[index].send({
        type: 'select_cards',
        cardIds: state.yourHand.slice(0, 2).map((card) => card.id),
      }));
    }

    const results = await Promise.all(clients.map((client) => client.waitFor(
      (message) => message.type === 'round_result' && message.roundIndex === roundIndex,
    )));
    if (roundIndex === 1) assert.equal(results[0].autoSelectedPlayerIds.length, 2);
    assert.equal(typeof results[0].settlementText, 'string');
    assert.ok(results[0].settlementText.length > 0);
    if (roundIndex === 3) assert.ok(results[0].publicCard);

    const confirmingStates = await waitForState(clients, 'ROUND_CONFIRM', roundIndex);
    assert.equal(confirmingStates[0].publicCards.length, 3 - roundIndex);
    assert.equal(confirmingStates.every((state) => state.roundHistory.length === roundIndex + 1), true);
    assert.equal(confirmingStates.every((state) => state.revealedHands.length === 3), true);
    assert.equal(confirmingStates.every((state) => state.revealedHands.every(
      (player) => player.cards.length === 3 && player.evaluationName,
    )), true);
    clients.forEach((client) => client.send({ type: 'confirm_round' }));
  }

  await Promise.all(clients.map((client) => client.waitFor(
    (message) => message.type === 'round_result' && message.roundIndex === 4,
  )));
  const finishedStates = await waitForState(clients, 'FINISHED', 4);
  assert.equal(finishedStates[0].players.reduce((sum, player) => sum + player.score, 0), 0);
  assert.equal(finishedStates.every((state) => state.roundHistory.length === 5), true);

  clients.forEach((client) => { client.messages = []; });
  clients.forEach((client) => client.send({ type: 'play_again' }));
  const replayStates = await waitForState(clients, 'SELECTING', 0);
  assert.equal(replayStates[0].publicCards.length, 4);
  assert.ok(replayStates[0].selectionEndsAt > Date.now());

  clients.forEach((client) => { client.messages = []; });
  clients[0].send({ type: 'exit_room' });
  await clients[0].waitFor((message) => message.type === 'room_exited');
  const departureNotices = await Promise.all(clients.slice(1).map((client) => client.waitFor(
    (message) => message.type === 'player_left' && message.playerName === '甲',
  )));
  assert.equal(departureNotices.every((message) => message.interrupted), true);
  const waitingStates = await waitForState(clients.slice(1), 'WAITING', 0);
  assert.equal(waitingStates.every((state) => state.players.length === 2), true);
  assert.equal(waitingStates.every((state) => state.players.every((player) => player.score === 0)), true);
  console.log(`联机测试通过：房间 ${creatorSession.roomCode} 已完成计时、亮牌、确认、再来一局和中途退出流程`);
} finally {
  clients.forEach((client) => client.close());
}
