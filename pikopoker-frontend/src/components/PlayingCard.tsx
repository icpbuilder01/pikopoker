import { cardLabel, cardSuit } from "../lib/cards";

interface PlayingCardProps {
  card?: number | null; // undefined/null = face down
  small?: boolean;
}

export function PlayingCard({ card, small }: PlayingCardProps) {
  if (card === undefined || card === null) {
    return (
      <div className={`playing-card face-down ${small ? "small" : ""}`} aria-hidden="true">
        <div className="playing-card-back-pattern" />
      </div>
    );
  }
  const suit = cardSuit(card);
  const label = cardLabel(card);
  return (
    <div className={`playing-card ${suit.color} ${small ? "small" : ""}`}>
      <span className="playing-card-corner playing-card-corner-tl">
        <span className="playing-card-corner-rank">{label}</span>
        <span className="playing-card-corner-suit">{suit.label}</span>
      </span>
      <span className="playing-card-pip">{suit.label}</span>
      <span className="playing-card-corner playing-card-corner-br">
        <span className="playing-card-corner-rank">{label}</span>
        <span className="playing-card-corner-suit">{suit.label}</span>
      </span>
    </div>
  );
}
