// Client-side hand-strength labeling for the "what do I have" indicator --
// mirrors pikopoker/src/cards.mo's evaluate5/evaluateBest category logic
// (same card encoding: card = suit*13 + rank), simplified to just return a
// category label instead of a full tiebreak score, since this is purely
// informational display, never compared between players.

function rankOf(card: number): number {
  return card % 13;
}

function suitOf(card: number): number {
  return Math.floor(card / 13);
}

function distinctRanksDesc(ranks: number[]): number[] {
  return Array.from(new Set(ranks)).sort((a, b) => b - a);
}

// Top rank of a straight within distinct descending ranks, or null. The
// wheel (A-2-3-4-5) returns 3 ("5"), matching cards.mo's convention.
function straightTop(ranksDesc: number[]): number | null {
  let run = 1;
  for (let i = 0; i + 1 < ranksDesc.length; i++) {
    if (ranksDesc[i] === ranksDesc[i + 1] + 1) {
      run += 1;
      if (run >= 5) return ranksDesc[i - 3];
    } else {
      run = 1;
    }
  }
  if (ranksDesc.length >= 5 && ranksDesc[0] === 12) {
    const has = (t: number) => ranksDesc.includes(t);
    if (has(3) && has(2) && has(1) && has(0)) return 3;
  }
  return null;
}

interface Score {
  category: number; // 0 high card .. 8 straight flush
  topRank: number; // meaningful for straight/straight-flush (royal check) and flush/high-card ties
}

function evaluate5(cards: number[]): Score {
  const ranks = cards.map(rankOf);
  const suits = cards.map(suitOf);
  const isFlush = suits.every((s) => s === suits[0]);

  const counts = new Array<number>(13).fill(0);
  for (const r of ranks) counts[r] += 1;
  const shape = counts.filter((c) => c > 0).sort((a, b) => b - a);

  const ranksDesc = distinctRanksDesc(ranks);
  const top = ranksDesc.length === 5 ? straightTop(ranksDesc) : null;

  if (top !== null && isFlush) return { category: 8, topRank: top };
  if (shape[0] === 4) return { category: 7, topRank: 0 };
  if (shape[0] === 3 && shape[1] === 2) return { category: 6, topRank: 0 };
  if (isFlush) return { category: 5, topRank: Math.max(...ranks) };
  if (top !== null) return { category: 4, topRank: top };
  if (shape[0] === 3) return { category: 3, topRank: 0 };
  if (shape[0] === 2 && shape[1] === 2) return { category: 2, topRank: 0 };
  if (shape[0] === 2) return { category: 1, topRank: 0 };
  return { category: 0, topRank: Math.max(...ranks) };
}

function isBetter(a: Score, b: Score): boolean {
  if (a.category !== b.category) return a.category > b.category;
  return a.topRank > b.topRank;
}

function combinations5(cards: number[]): number[][] {
  const combos: number[][] = [];
  const combo: number[] = [];
  function recurse(start: number) {
    if (combo.length === 5) {
      combos.push([...combo]);
      return;
    }
    for (let i = start; i < cards.length; i++) {
      combo.push(cards[i]);
      recurse(i + 1);
      combo.pop();
    }
  }
  recurse(0);
  return combos;
}

function bestOf(cards: number[]): Score | null {
  if (cards.length < 5) return null;
  let best: Score | null = null;
  for (const combo of combinations5(cards)) {
    const score = evaluate5(combo);
    if (!best || isBetter(score, best)) best = score;
  }
  return best;
}

const CATEGORY_NAMES = [
  "High Card",
  "Pair",
  "Two Pair",
  "Three of a Kind",
  "Straight",
  "Flush",
  "Full House",
  "Four of a Kind",
  "Straight Flush",
];

/** Human-readable label for the best hand made from hole cards + board so far, or null if there's nothing to show yet. */
export function handLabel(holeCards: [number, number] | undefined, board: ArrayLike<number>): string | null {
  if (!holeCards) return null;
  const all = [holeCards[0], holeCards[1], ...Array.from(board)];
  if (all.length === 2) {
    return rankOf(all[0]) === rankOf(all[1]) ? "Pocket Pair" : "High Card";
  }
  const best = bestOf(all);
  if (!best) return null;
  if (best.category === 8) return best.topRank === 12 ? "Royal Flush" : "Straight Flush";
  return CATEGORY_NAMES[best.category];
}
