import { randomUUID } from 'node:crypto';
import { createDeck, ROUND_SCORES, settleThreeHands, shuffle } from './game.js';

const parsedSelectDuration = Number(process.env.SELECT_DURATION_MS || 30000);
const parsedRevealDuration = Number(process.env.REVEAL_DURATION_MS || 3000);
export const SELECT_DURATION_MS = Number.isFinite(parsedSelectDuration)
  ? Math.max(100, parsedSelectDuration)
  : 30000;
export const REVEAL_DURATION_MS = Number.isFinite(parsedRevealDuration)
  ? Math.max(100, parsedRevealDuration)
  : 3000;

export class GameRoom {
  constructor(code) {
    this.code = code;
    this.players = [];
    this.phase = 'WAITING';
    this.roundIndex = 0;
    this.deck = [];
    this.publicCards = [];
    this.hiddenPublicCardId = null;
    this.selections = new Map();
    this.autoSelectedPlayerIds = new Set();
    this.confirmedPlayerIds = new Set();
    this.replayPlayerIds = new Set();
    this.selectionEndsAt = null;
    this.revealEndsAt = null;
    this.lastResult = null;
    this.roundHistory = [];
  }

  addPlayer(name) {
    if (this.phase !== 'WAITING') throw new Error('牌局已经开始');
    if (this.players.length >= 3) throw new Error('房间已经满员');
    const safeName = String(name || '').trim().slice(0, 12) || `玩家${this.players.length + 1}`;
    const player = {
      id: randomUUID(),
      name: safeName,
      ready: false,
      connected: true,
      hand: [],
      score: 0,
    };
    this.players.push(player);
    return player;
  }

  getPlayer(playerId) {
    return this.players.find((player) => player.id === playerId) ?? null;
  }

  setConnected(playerId, connected) {
    const player = this.getPlayer(playerId);
    if (player) player.connected = connected;
  }

  setReady(playerId) {
    if (this.phase !== 'WAITING') throw new Error('当前不能准备');
    const player = this.getPlayer(playerId);
    if (!player) throw new Error('玩家不存在');
    player.ready = true;
    if (this.players.length === 3 && this.players.every((item) => item.ready)) {
      this.start();
      return true;
    }
    return false;
  }

  start() {
    if (this.players.length !== 3) throw new Error('必须正好3名玩家');
    this.deck = shuffle(createDeck());
    this.publicCards = [];
    this.selections.clear();
    this.autoSelectedPlayerIds.clear();
    this.confirmedPlayerIds.clear();
    this.replayPlayerIds.clear();
    this.lastResult = null;
    this.roundHistory = [];
    this.roundIndex = 0;

    for (const player of this.players) {
      player.hand = [];
      player.score = 0;
      player.ready = false;
    }

    // Deal one card at a time so the process matches a physical table.
    for (let cardNumber = 0; cardNumber < 5; cardNumber += 1) {
      for (const player of this.players) player.hand.push(this.draw());
    }
    for (let index = 0; index < 4; index += 1) this.publicCards.push(this.draw());
    this.hiddenPublicCardId = this.publicCards[3].id;
    this.beginSelection();
  }

  beginSelection() {
    this.phase = 'SELECTING';
    this.selections.clear();
    this.autoSelectedPlayerIds.clear();
    this.confirmedPlayerIds.clear();
    this.selectionEndsAt = Date.now() + SELECT_DURATION_MS;
    this.revealEndsAt = null;
  }

  draw() {
    const card = this.deck.pop();
    if (!card) throw new Error('牌堆已空');
    return card;
  }

  selectCards(playerId, cardIds) {
    if (this.phase !== 'SELECTING' || this.roundIndex > 3) {
      throw new Error('当前不是选牌阶段');
    }
    const player = this.getPlayer(playerId);
    if (!player) throw new Error('玩家不存在');
    if (this.selections.has(playerId)) throw new Error('本轮已经锁定选牌');
    if (!Array.isArray(cardIds) || cardIds.length !== 2 || new Set(cardIds).size !== 2) {
      throw new Error('必须选择两张不同的牌');
    }
    const selected = cardIds.map((id) => player.hand.find((card) => card.id === id));
    if (selected.some((card) => !card)) throw new Error('选中的牌不在你的手牌中');

    this.selections.set(playerId, selected);
    if (this.selections.size === this.players.length) return this.resolveSelectedRound();
    return null;
  }

  autoSelectMissing() {
    if (this.phase !== 'SELECTING') return null;
    for (const player of this.players) {
      if (this.selections.has(player.id)) continue;
      if (player.hand.length < 2) throw new Error('自动选牌时手牌不足');
      this.selections.set(player.id, shuffle(player.hand).slice(0, 2));
      this.autoSelectedPlayerIds.add(player.id);
    }
    return this.resolveSelectedRound();
  }

  resolveSelectedRound() {
    const round = this.roundIndex;
    const publicCard = this.publicCards.shift();
    if (!publicCard) throw new Error('本轮公共牌不存在');
    const hands = this.players.map((player) => [
      ...this.selections.get(player.id),
      publicCard,
    ]);
    const settlement = settleThreeHands(hands, ROUND_SCORES[round]);

    this.players.forEach((player, index) => {
      const selectedIds = new Set(this.selections.get(player.id).map((card) => card.id));
      player.hand = player.hand.filter((card) => !selectedIds.has(card.id));
      player.score += settlement.deltas[index];
    });

    const result = this.makeResult(round, hands, settlement, publicCard);
    this.lastResult = result;
    this.roundHistory.push(result);
    this.phase = 'REVEALING';
    this.selectionEndsAt = null;
    this.revealEndsAt = Date.now() + REVEAL_DURATION_MS;
    this.confirmedPlayerIds.clear();
    this.selections.clear();
    return result;
  }

  finishReveal() {
    if (this.phase !== 'REVEALING') return false;
    this.revealEndsAt = null;
    if (this.roundIndex === 4) {
      this.phase = 'FINISHED';
      return true;
    }
    this.phase = 'ROUND_CONFIRM';
    this.confirmedPlayerIds.clear();
    return true;
  }

  confirmRound(playerId) {
    if (this.phase !== 'ROUND_CONFIRM') throw new Error('当前不需要确认');
    if (!this.getPlayer(playerId)) throw new Error('玩家不存在');
    this.confirmedPlayerIds.add(playerId);
    if (this.confirmedPlayerIds.size !== this.players.length) return null;

    this.confirmedPlayerIds.clear();
    if (this.roundIndex <= 2) {
      for (const player of this.players) player.hand.push(this.draw(), this.draw());
      this.roundIndex += 1;
      this.beginSelection();
      return null;
    }

    this.roundIndex = 4;
    return this.settleFinalRound();
  }

  settleFinalRound() {
    if (this.roundIndex !== 4) throw new Error('当前不能结算最后一轮');
    const hands = this.players.map((player) => {
      if (player.hand.length !== 3) throw new Error('最后一轮手牌数量不是3张');
      return [...player.hand];
    });
    const settlement = settleThreeHands(hands, ROUND_SCORES[4]);
    this.players.forEach((player, index) => {
      player.score += settlement.deltas[index];
    });
    const result = this.makeResult(4, hands, settlement, null);
    this.lastResult = result;
    this.roundHistory.push(result);
    this.phase = 'REVEALING';
    this.selectionEndsAt = null;
    this.revealEndsAt = Date.now() + REVEAL_DURATION_MS;
    return result;
  }

  requestReplay(playerId) {
    if (this.phase !== 'FINISHED') throw new Error('当前不能再来一回合');
    if (!this.getPlayer(playerId)) throw new Error('玩家不存在');
    this.replayPlayerIds.add(playerId);
    if (this.replayPlayerIds.size === this.players.length) {
      this.start();
      return true;
    }
    return false;
  }

  removePlayer(playerId) {
    const player = this.getPlayer(playerId);
    if (!player) throw new Error('玩家不存在');
    const previousPhase = this.phase;
    this.players = this.players.filter((player) => player.id !== playerId);
    this.resetToWaiting();
    return {
      playerId,
      playerName: player.name,
      interrupted: !['WAITING', 'FINISHED'].includes(previousPhase),
      previousPhase,
    };
  }

  resetToWaiting() {
    this.phase = 'WAITING';
    this.roundIndex = 0;
    this.deck = [];
    this.publicCards = [];
    this.hiddenPublicCardId = null;
    this.selections.clear();
    this.autoSelectedPlayerIds.clear();
    this.confirmedPlayerIds.clear();
    this.replayPlayerIds.clear();
    this.selectionEndsAt = null;
    this.revealEndsAt = null;
    this.lastResult = null;
    this.roundHistory = [];
    for (const player of this.players) {
      player.ready = false;
      player.hand = [];
      player.score = 0;
    }
  }

  makeResult(roundIndex, hands, settlement, publicCard) {
    const payments = settlement.pairResults.map((payment) => ({
      payerId: this.players[payment.payer].id,
      payerName: this.players[payment.payer].name,
      receiverId: this.players[payment.receiver].id,
      receiverName: this.players[payment.receiver].name,
      score: payment.score,
    }));
    let settlementText = '三家牌型相同，本轮不计分';
    if (
      payments.length === 2 &&
      payments[0].payerId === payments[1].payerId &&
      payments[0].score === payments[1].score
    ) {
      settlementText = `${payments[0].payerName}向${payments[0].receiverName}、${payments[1].receiverName}各付${payments[0].score}分`;
    } else if (
      payments.length === 2 &&
      payments[0].receiverId === payments[1].receiverId &&
      payments[0].score === payments[1].score
    ) {
      settlementText = `${payments[0].payerName}、${payments[1].payerName}分别向${payments[0].receiverName}付${payments[0].score}分`;
    } else if (payments.length) {
      settlementText = payments
        .map((payment) => `${payment.payerName}向${payment.receiverName}付${payment.score}分`)
        .join('；');
    }
    return {
      type: 'round_result',
      roundIndex,
      baseScore: ROUND_SCORES[roundIndex],
      publicCard,
      autoSelectedPlayerIds: [...this.autoSelectedPlayerIds],
      payments,
      settlementText,
      players: this.players.map((player, index) => ({
        id: player.id,
        name: player.name,
        cards: hands[index],
        evaluation: settlement.evaluations[index],
        delta: settlement.deltas[index],
        totalScore: player.score,
      })),
      pairResults: settlement.pairResults,
    };
  }

  snapshotFor(playerId) {
    const viewer = this.getPlayer(playerId);
    if (!viewer) throw new Error('玩家不存在');
    const visiblePublicCards = this.publicCards.map((card) =>
      card.id === this.hiddenPublicCardId && this.roundIndex <= 3 ? null : card,
    );
    const topScore = Math.max(...this.players.map((player) => player.score));
    return {
      type: 'state',
      roomCode: this.code,
      phase: this.phase,
      roundIndex: this.roundIndex,
      baseScore: ROUND_SCORES[this.roundIndex] ?? null,
      publicCards: visiblePublicCards,
      deckCount: this.deck.length,
      currentPublicCard:
        this.phase === 'SELECTING' && this.roundIndex <= 3
          ? visiblePublicCards[0] ?? null
          : null,
      selectionEndsAt: this.selectionEndsAt,
      revealEndsAt: this.revealEndsAt,
      yourPlayerId: playerId,
      yourHand: viewer.hand,
      selectedPlayerIds: [...this.selections.keys()],
      confirmedPlayerIds: [...this.confirmedPlayerIds],
      replayPlayerIds: [...this.replayPlayerIds],
      revealedHands:
        ['REVEALING', 'ROUND_CONFIRM'].includes(this.phase) && this.lastResult
          ? this.lastResult.players.map((player) => ({
              id: player.id,
              name: player.name,
              cards: player.cards,
              evaluationName: player.evaluation.name,
              delta: player.delta,
            }))
          : [],
      settlementText:
        ['REVEALING', 'ROUND_CONFIRM'].includes(this.phase) && this.lastResult
          ? this.lastResult.settlementText
          : '',
      roundHistory: this.roundHistory.map((result) => ({
        roundIndex: result.roundIndex,
        baseScore: result.baseScore,
        publicCard: result.publicCard,
        settlementText: result.settlementText,
        players: result.players.map((player) => ({
          id: player.id,
          name: player.name,
          cards: player.cards,
          evaluationName: player.evaluation.name,
          delta: player.delta,
          totalScore: player.totalScore,
        })),
      })),
      players: this.players.map((player) => ({
        id: player.id,
        name: player.name,
        ready: player.ready,
        connected: player.connected,
        handCount: player.hand.length,
        score: player.score,
      })),
      winnerIds:
        this.phase === 'FINISHED'
          ? this.players.filter((player) => player.score === topScore).map((player) => player.id)
          : [],
    };
  }
}
