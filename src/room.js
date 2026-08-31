import { randomUUID } from 'node:crypto';
import { createDeck, ROUND_SCORES, settleThreeHands, shuffle } from './game.js';

export class GameRoom {
  constructor(code) {
    this.code = code;
    this.players = [];
    this.phase = 'WAITING';
    this.roundIndex = 0;
    this.deck = [];
    this.publicCards = [];
    this.selections = new Map();
    this.lastResult = null;
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
    this.lastResult = null;
    this.roundIndex = 0;
    this.phase = 'SELECTING';

    for (const player of this.players) {
      player.hand = [];
      player.score = 0;
      player.ready = false;
    }

    // Deal one card at a time so the process matches a physical table.
    for (let cardNumber = 0; cardNumber < 5; cardNumber += 1) {
      for (const player of this.players) {
        player.hand.push(this.draw());
      }
    }
    for (let i = 0; i < 4; i += 1) this.publicCards.push(this.draw());
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
    if (this.selections.size === 3) return this.resolveSelectedRound();
    return null;
  }

  resolveSelectedRound() {
    const round = this.roundIndex;
    const publicCard = this.publicCards[round];
    const hands = this.players.map((player) => [
      ...this.selections.get(player.id),
      publicCard,
    ]);
    const settlement = settleThreeHands(hands, ROUND_SCORES[round]);

    this.players.forEach((player, index) => {
      const selectedIds = new Set(this.selections.get(player.id).map((card) => card.id));
      player.hand = player.hand.filter((card) => !selectedIds.has(card.id));
      player.score += settlement.deltas[index];
      if (round <= 2) {
        player.hand.push(this.draw(), this.draw());
      }
    });

    const result = this.makeResult(round, hands, settlement);
    this.lastResult = result;
    this.selections.clear();

    if (round === 3) {
      this.roundIndex = 4;
      this.phase = 'FINAL_PENDING';
    } else {
      this.roundIndex += 1;
      this.phase = 'SELECTING';
    }
    return result;
  }

  settleFinalRound() {
    if (this.phase !== 'FINAL_PENDING' || this.roundIndex !== 4) {
      throw new Error('当前不能结算最后一轮');
    }
    const hands = this.players.map((player) => {
      if (player.hand.length !== 3) throw new Error('最后一轮手牌数量不是3张');
      return [...player.hand];
    });
    const settlement = settleThreeHands(hands, ROUND_SCORES[4]);
    this.players.forEach((player, index) => {
      player.score += settlement.deltas[index];
    });
    const result = this.makeResult(4, hands, settlement);
    this.lastResult = result;
    this.phase = 'FINISHED';
    return result;
  }

  makeResult(roundIndex, hands, settlement) {
    return {
      type: 'round_result',
      roundIndex,
      baseScore: ROUND_SCORES[roundIndex],
      publicCard: roundIndex < 4 ? this.publicCards[roundIndex] : null,
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
    const fourthPublicVisible = this.roundIndex >= 4 || this.phase === 'FINISHED';
    const visiblePublicCards = this.publicCards.map((card, index) =>
      index === 3 && !fourthPublicVisible ? null : card,
    );
    const currentPublicCard =
      this.phase === 'SELECTING' && this.roundIndex <= 2
        ? this.publicCards[this.roundIndex]
        : null;

    const topScore = Math.max(...this.players.map((player) => player.score));
    return {
      type: 'state',
      roomCode: this.code,
      phase: this.phase,
      roundIndex: this.roundIndex,
      baseScore: ROUND_SCORES[this.roundIndex] ?? null,
      publicCards: visiblePublicCards,
      currentPublicCard,
      yourPlayerId: playerId,
      yourHand: viewer.hand,
      selectedPlayerIds: [...this.selections.keys()],
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
