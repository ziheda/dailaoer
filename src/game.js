import { randomInt } from 'node:crypto';

export const SUITS = ['club', 'diamond', 'heart', 'spade'];
export const ROUND_SCORES = [1, 2, 3, 4, 5];

export const HAND_CATEGORY = Object.freeze({
  SPECIAL_235: 0,
  HIGH_CARD: 1,
  PAIR: 2,
  STRAIGHT: 3,
  FLUSH: 4,
  STRAIGHT_FLUSH: 5,
  BAO_ZI: 6,
});

const CATEGORY_NAME = Object.freeze({
  [HAND_CATEGORY.SPECIAL_235]: '235',
  [HAND_CATEGORY.HIGH_CARD]: '散牌',
  [HAND_CATEGORY.PAIR]: '对子',
  [HAND_CATEGORY.STRAIGHT]: '顺子',
  [HAND_CATEGORY.FLUSH]: '金花',
  [HAND_CATEGORY.STRAIGHT_FLUSH]: '同花顺',
  [HAND_CATEGORY.BAO_ZI]: '豹子',
});

export function createStandardDeck() {
  const cards = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank += 1) {
      cards.push({ id: `${suit}-${rank}`, suit, rank });
    }
  }
  return cards;
}

export function createDeck() {
  return [
    ...createStandardDeck(),
    { id: 'joker-small', suit: 'joker', rank: null, isJoker: true, jokerName: '小王' },
    { id: 'joker-big', suit: 'joker', rank: null, isJoker: true, jokerName: '大王' },
  ];
}

export function shuffle(cards, rng = null) {
  const deck = [...cards];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = rng ? Math.floor(rng() * (i + 1)) : randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function compareKey(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function straightHigh(ranksAscending) {
  const signature = ranksAscending.join(',');
  if (signature === '2,3,14') return 3;
  if (
    ranksAscending[1] === ranksAscending[0] + 1 &&
    ranksAscending[2] === ranksAscending[1] + 1
  ) {
    return ranksAscending[2];
  }
  return null;
}

function evaluateNaturalHand(cards) {
  const ranksAscending = cards.map((card) => card.rank).sort((a, b) => a - b);
  const ranksDescending = [...ranksAscending].sort((a, b) => b - a);
  const is235 = ranksAscending.join(',') === '2,3,5';

  // This game's house rule makes every 235 the absolute smallest hand.
  if (is235) {
    return {
      category: HAND_CATEGORY.SPECIAL_235,
      type: 'SPECIAL_235',
      name: CATEGORY_NAME[HAND_CATEGORY.SPECIAL_235],
      key: [0],
    };
  }

  const counts = new Map();
  for (const rank of ranksAscending) {
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }

  if (counts.size === 1) {
    const rank = ranksAscending[0];
    return {
      category: HAND_CATEGORY.BAO_ZI,
      type: 'BAO_ZI',
      name: rank === 14 ? 'AAA豹子' : CATEGORY_NAME[HAND_CATEGORY.BAO_ZI],
      key: [rank],
    };
  }

  const isFlush = cards.every((card) => card.suit === cards[0].suit);
  const highStraightCard = straightHigh(ranksAscending);

  if (isFlush && highStraightCard !== null) {
    return {
      category: HAND_CATEGORY.STRAIGHT_FLUSH,
      type: 'STRAIGHT_FLUSH',
      name: CATEGORY_NAME[HAND_CATEGORY.STRAIGHT_FLUSH],
      key: [highStraightCard],
    };
  }

  if (isFlush) {
    return {
      category: HAND_CATEGORY.FLUSH,
      type: 'FLUSH',
      name: CATEGORY_NAME[HAND_CATEGORY.FLUSH],
      key: ranksDescending,
    };
  }

  if (highStraightCard !== null) {
    return {
      category: HAND_CATEGORY.STRAIGHT,
      type: 'STRAIGHT',
      name: CATEGORY_NAME[HAND_CATEGORY.STRAIGHT],
      key: [highStraightCard],
    };
  }

  const pairEntry = [...counts.entries()].find(([, count]) => count === 2);
  if (pairEntry) {
    const pairRank = pairEntry[0];
    const kicker = [...counts.entries()].find(([, count]) => count === 1)[0];
    return {
      category: HAND_CATEGORY.PAIR,
      type: 'PAIR',
      name: CATEGORY_NAME[HAND_CATEGORY.PAIR],
      key: [pairRank, kicker],
    };
  }

  return {
    category: HAND_CATEGORY.HIGH_CARD,
    type: 'HIGH_CARD',
    name: CATEGORY_NAME[HAND_CATEGORY.HIGH_CARD],
    key: ranksDescending,
  };
}

export function evaluateHand(cards) {
  if (!Array.isArray(cards) || cards.length !== 3) {
    throw new Error('牌型必须正好包含3张牌');
  }

  const jokers = cards.filter((card) => card.isJoker || card.suit === 'joker');
  if (jokers.length === 0) {
    return {
      ...evaluateNaturalHand(cards),
      resolvedCards: cards,
      jokerAssignments: [],
    };
  }
  if (jokers.length > 2) throw new Error('一副牌最多只有两张王');

  const usedIds = new Set(cards.filter((card) => !card.isJoker).map((card) => card.id));
  const candidates = createStandardDeck().filter((card) => !usedIds.has(card.id));
  let best = null;

  const consider = (assignedCards) => {
    const assignmentByJoker = new Map(
      jokers.map((joker, index) => [joker.id, assignedCards[index]]),
    );
    const resolvedCards = cards.map((card) =>
      card.isJoker || card.suit === 'joker' ? assignmentByJoker.get(card.id) : card,
    );
    const evaluation = evaluateNaturalHand(resolvedCards);
    const candidate = {
      ...evaluation,
      resolvedCards,
      jokerAssignments: jokers.map((joker, index) => ({
        jokerId: joker.id,
        jokerName: joker.jokerName,
        asCard: assignedCards[index],
      })),
    };
    if (!best || compareEvaluations(candidate, best) > 0) best = candidate;
  };

  if (jokers.length === 1) {
    for (const candidate of candidates) consider([candidate]);
  } else {
    for (let left = 0; left < candidates.length; left += 1) {
      for (let right = left + 1; right < candidates.length; right += 1) {
        consider([candidates[left], candidates[right]]);
      }
    }
  }

  return best;
}

export function compareEvaluations(a, b) {
  if (a.category !== b.category) return Math.sign(a.category - b.category);
  return compareKey(a.key, b.key);
}

export function compareHands(a, b) {
  return compareEvaluations(evaluateHand(a), evaluateHand(b));
}

export function settleThreeHands(hands, baseScore) {
  if (!Array.isArray(hands) || hands.length !== 3) {
    throw new Error('结算必须包含3名玩家的牌');
  }
  if (!Number.isInteger(baseScore) || baseScore <= 0) {
    throw new Error('基础分必须是正整数');
  }

  const evaluations = hands.map(evaluateHand);
  const deltas = [0, 0, 0];
  const pairResults = [];
  const pairs = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];

  for (const [left, right] of pairs) {
    const comparison = compareEvaluations(evaluations[left], evaluations[right]);
    if (comparison === 0) {
      pairResults.push({ left, right, winner: null, score: 0 });
      continue;
    }

    const bothBaoZi =
      evaluations[left].category === HAND_CATEGORY.BAO_ZI &&
      evaluations[right].category === HAND_CATEGORY.BAO_ZI;
    const score = baseScore * (bothBaoZi ? 2 : 1);
    const winner = comparison > 0 ? left : right;
    const loser = comparison > 0 ? right : left;
    deltas[winner] += score;
    deltas[loser] -= score;
    pairResults.push({ left, right, winner, score, bothBaoZi });
  }

  if (deltas.reduce((sum, value) => sum + value, 0) !== 0) {
    throw new Error('计分守恒校验失败');
  }

  return { evaluations, deltas, pairResults };
}
