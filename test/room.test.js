import assert from 'node:assert/strict';
import test from 'node:test';
import { settleThreeHands } from '../src/game.js';
import { GameRoom } from '../src/room.js';

const card = (rank, suit = 'club') => ({ id: `${suit}-${rank}`, rank, suit });

function createStartedRoom() {
  const room = new GameRoom('123456');
  const players = ['甲', '乙', '丙'].map((name) => room.addPlayer(name));
  players.forEach((player) => room.setReady(player.id));
  return { room, players };
}

function selectFirstTwoForEveryone(room) {
  let result = null;
  for (const player of room.players) {
    result = room.selectCards(player.id, player.hand.slice(0, 2).map((card) => card.id));
  }
  return result;
}

function confirmEveryone(room) {
  let result = null;
  for (const player of room.players) result = room.confirmRound(player.id);
  return result;
}

test('三家牌型不同时由中间玩家分别付给最大和最小玩家', () => {
  const highest = [card(14), card(13, 'heart'), card(12, 'spade')];
  const middle = [card(11), card(10, 'heart'), card(9, 'spade')];
  const lowest = [card(2), card(3, 'heart'), card(5, 'spade')];
  const result = settleThreeHands([highest, middle, lowest], 3);
  assert.deepEqual(result.deltas, [3, -6, 3]);
});

test('豹子、对子、散牌时对子玩家向另外两家分别付分', () => {
  const baoZi = [card(14), card(14, 'heart'), card(14, 'spade')];
  const pair = [card(13), card(13, 'heart'), card(8, 'spade')];
  const highCard = [card(12), card(10, 'heart'), card(7, 'spade')];
  assert.deepEqual(settleThreeHands([baoZi, pair, highCard], 1).deltas, [1, -2, 1]);
  assert.deepEqual(settleThreeHands([baoZi, pair, highCard], 2).deltas, [2, -4, 2]);
});

test('两家同为最大牌时由较小的第三家分别付分', () => {
  const sameA = [card(14), card(10, 'heart'), card(8, 'spade')];
  const sameB = [card(14, 'diamond'), card(10, 'spade'), card(8, 'heart')];
  const lower = [card(13), card(10, 'diamond'), card(8, 'club')];
  const result = settleThreeHands([sameA, sameB, lower], 4);
  assert.deepEqual(result.deltas, [4, 4, -8]);
});

test('两家同为较小牌时两家分别付给较大的第三家', () => {
  const higher = [card(14), card(11, 'heart'), card(8, 'spade')];
  const sameA = [card(13), card(10, 'diamond'), card(8, 'club')];
  const sameB = [card(13, 'heart'), card(10, 'spade'), card(8, 'diamond')];
  const result = settleThreeHands([higher, sameA, sameB], 2);
  assert.deepEqual(result.deltas, [4, -2, -2]);
});

test('每轮消耗公共牌、亮牌、确认后补牌并完成五轮', () => {
  const { room, players } = createStartedRoom();
  assert.equal(room.phase, 'SELECTING');
  assert.equal(room.publicCards.length, 4);
  assert.equal(room.snapshotFor(players[0].id).deckCount, 35);
  assert.ok(room.selectionEndsAt > Date.now());
  room.players.forEach((player) => assert.equal(player.hand.length, 5));

  const firstResult = selectFirstTwoForEveryone(room);
  assert.equal(firstResult.roundIndex, 0);
  assert.equal(room.phase, 'REVEALING');
  assert.equal(room.publicCards.length, 3);
  assert.equal(room.roundHistory.length, 1);
  assert.equal(room.snapshotFor(players[0].id).revealedHands.length, 3);
  room.players.forEach((player) => assert.equal(player.hand.length, 3));

  room.finishReveal();
  assert.equal(room.phase, 'ROUND_CONFIRM');
  room.confirmRound(players[0].id);
  room.confirmRound(players[1].id);
  room.players.forEach((player) => assert.equal(player.hand.length, 3));
  room.confirmRound(players[2].id);
  assert.equal(room.phase, 'SELECTING');
  assert.equal(room.roundIndex, 1);
  assert.equal(room.snapshotFor(players[0].id).deckCount, 29);
  room.players.forEach((player) => assert.equal(player.hand.length, 5));

  room.selectCards(players[0].id, players[0].hand.slice(0, 2).map((card) => card.id));
  const timedResult = room.autoSelectMissing();
  assert.equal(timedResult.autoSelectedPlayerIds.length, 2);
  assert.equal(room.publicCards.length, 2);
  room.finishReveal();
  confirmEveryone(room);

  selectFirstTwoForEveryone(room);
  assert.equal(room.publicCards.length, 1);
  room.finishReveal();
  confirmEveryone(room);

  const fourthRoundBeforeSelection = room.snapshotFor(players[0].id);
  assert.equal(fourthRoundBeforeSelection.roundIndex, 3);
  assert.deepEqual(fourthRoundBeforeSelection.publicCards, [null]);
  const fourthResult = selectFirstTwoForEveryone(room);
  assert.ok(fourthResult.publicCard);
  assert.equal(
    fourthResult.players.every((player) =>
      player.cards.some((item) => item.id === fourthResult.publicCard.id),
    ),
    true,
  );
  assert.equal(room.publicCards.length, 0);
  room.finishReveal();
  const finalResult = confirmEveryone(room);
  assert.equal(finalResult.roundIndex, 4);
  assert.equal(room.phase, 'REVEALING');
  assert.equal(room.roundHistory.length, 5);
  assert.equal(room.snapshotFor(players[0].id).roundHistory.length, 5);
  room.players.forEach((player) => assert.equal(player.hand.length, 3));

  room.finishReveal();
  assert.equal(room.phase, 'FINISHED');
  assert.equal(room.players.reduce((sum, player) => sum + player.score, 0), 0);
});

test('三名玩家都选择再来一回合后才重新发牌', () => {
  const { room, players } = createStartedRoom();
  for (let round = 0; round < 4; round += 1) {
    selectFirstTwoForEveryone(room);
    room.finishReveal();
    confirmEveryone(room);
  }
  room.finishReveal();
  assert.equal(room.phase, 'FINISHED');

  room.requestReplay(players[0].id);
  room.requestReplay(players[1].id);
  assert.equal(room.phase, 'FINISHED');
  assert.deepEqual([...room.replayPlayerIds], [players[0].id, players[1].id]);
  const started = room.requestReplay(players[2].id);
  assert.equal(started, true);
  assert.equal(room.phase, 'SELECTING');
  assert.equal(room.roundIndex, 0);
  assert.equal(room.publicCards.length, 4);
  room.players.forEach((player) => {
    assert.equal(player.score, 0);
    assert.equal(player.hand.length, 5);
  });
});

test('牌局进行中有人退出时中止本局并让其余玩家留在房间等待', () => {
  const { room, players } = createStartedRoom();
  const result = room.removePlayer(players[0].id);
  assert.equal(result.playerName, '甲');
  assert.equal(result.interrupted, true);
  assert.equal(result.previousPhase, 'SELECTING');
  assert.equal(room.players.length, 2);
  assert.equal(room.phase, 'WAITING');
  assert.equal(room.publicCards.length, 0);
  room.players.forEach((player) => {
    assert.equal(player.ready, false);
    assert.equal(player.hand.length, 0);
    assert.equal(player.score, 0);
  });
});
