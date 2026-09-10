// Client-side hand evaluation -- mirrors pikopoker/src/cards.mo's
// evaluate5/evaluateBest/compareHandScore exactly (same card encoding:
// card = suit*13 + rank, rank 0="2"..12="A"), including the full kicker
// tiebreak, not just a category label. Originally this only needed to
// label the viewer's own best-hand-so-far, where a category name was
// enough -- but showdownSummary() in TableRoom.tsx needs to determine who
// *actually* won among several revealed hands, which has to agree with
// how the backend really settles the pot, so the simplified version was
// replaced with a faithful port instead of extended piecemeal.

export interface HandScore {
  category: number; // 0 high card .. 8 straight flush
  kickers: number[]; // exactly 5, tiebreak order -- see cards.mo's own comment on genericKickers
}

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

/** Evaluates exactly 5 cards. */
export function evaluate5(cards: number[]): HandScore {
  const ranks = cards.map(rankOf);
  const suits = cards.map(suitOf);
  const isFlush = suits.every((s) => s === suits[0]);

  const counts = new Array<number>(13).fill(0);
  for (const r of ranks) counts[r] += 1;

  // Generic kicker order for ANY category: ranks sorted by (count desc,
  // rank desc) -- correctly orders quad/trips/pair kickers, two-pair's two
  // pairs then the odd card, and plain high-card hands, all with the same
  // rule (see cards.mo's byCountThenRank).
  const genericKickers = [...ranks].sort((x, y) => (counts[x] !== counts[y] ? counts[y] - counts[x] : y - x));

  const ranksDesc = distinctRanksDesc(ranks);
  const top = ranksDesc.length === 5 ? straightTop(ranksDesc) : null;

  const sortedCounts = [...counts].sort((a, b) => b - a);
  const shape = sortedCounts.filter((c) => c > 0);

  if (top !== null && isFlush) return { category: 8, kickers: [top, 0, 0, 0, 0] };
  if (shape[0] === 4) return { category: 7, kickers: genericKickers };
  if (shape[0] === 3 && shape[1] === 2) return { category: 6, kickers: genericKickers };
  if (isFlush) return { category: 5, kickers: [...ranks].sort((a, b) => b - a) };
  if (top !== null) return { category: 4, kickers: [top, 0, 0, 0, 0] };
  if (shape[0] === 3) return { category: 3, kickers: genericKickers };
  if (shape[0] === 2 && shape[1] === 2) return { category: 2, kickers: genericKickers };
  if (shape[0] === 2) return { category: 1, kickers: genericKickers };
  return { category: 0, kickers: genericKickers };
}

/** Positive if `a` beats `b`, negative if `b` beats `a`, 0 if exactly tied. */
export function compareHandScore(a: HandScore, b: HandScore): number {
  if (a.category !== b.category) return a.category - b.category;
  for (let i = 0; i < 5; i++) {
    if (a.kickers[i] !== b.kickers[i]) return a.kickers[i] - b.kickers[i];
  }
  return 0;
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

/** Best 5-card score out of `cards` (brute-force over every 5-card combination), or null if fewer than 5 cards. */
export function evaluateBest(cards: number[]): HandScore | null {
  if (cards.length < 5) return null;
  let best: HandScore | null = null;
  for (const combo of combinations5(cards)) {
    const score = evaluate5(combo);
    if (!best || compareHandScore(score, best) > 0) best = score;
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

export function labelForScore(score: HandScore): string {
  if (score.category === 8) return score.kickers[0] === 12 ? "Royal Flush" : "Straight Flush";
  return CATEGORY_NAMES[score.category];
}

/** Human-readable label for the best hand made from hole cards + board so far, or null if there's nothing to show yet. */
export function handLabel(holeCards: [number, number] | undefined, board: ArrayLike<number>): string | null {
  if (!holeCards) return null;
  const all = [holeCards[0], holeCards[1], ...Array.from(board)];
  if (all.length === 2) {
    return rankOf(all[0]) === rankOf(all[1]) ? "Pocket Pair" : "High Card";
  }
  const best = evaluateBest(all);
  return best ? labelForScore(best) : null;
}
