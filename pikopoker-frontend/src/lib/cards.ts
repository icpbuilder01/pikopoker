// Mirrors pikopoker/src/cards.mo's encoding exactly: card = suit*13 + rank,
// rank 0="2" .. 12="A", suit 0..3.
const RANK_LABELS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const SUITS = [
  { label: "♣", color: "black" as const },
  { label: "♦", color: "red" as const },
  { label: "♥", color: "red" as const },
  { label: "♠", color: "black" as const },
];

export function rankOf(card: number): number {
  return card % 13;
}

export function suitOf(card: number): number {
  return Math.floor(card / 13);
}

export function cardLabel(card: number): string {
  return RANK_LABELS[rankOf(card)];
}

export function cardSuit(card: number): { label: string; color: "black" | "red" } {
  return SUITS[suitOf(card)];
}
