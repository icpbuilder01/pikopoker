import { PlayingCard } from "./PlayingCard";
import { Modal } from "./Modal";

interface HandRank {
  name: string;
  cards: number[];
  blurb: string;
}

// card = suit*13 + rank, rank 0="2"..12="A", suit 0=clubs,1=diamonds,2=hearts,3=spades
// (mirrors pikopoker/src/cards.mo -- see lib/cards.ts).
const HAND_RANKS: HandRank[] = [
  { name: "Royal Flush", cards: [47, 48, 49, 50, 51], blurb: "10 through Ace, one suit. The best hand there is." },
  { name: "Straight Flush", cards: [16, 17, 18, 19, 20], blurb: "Five in a row, one suit." },
  { name: "Four of a Kind", cards: [5, 18, 31, 44, 50], blurb: "Four cards of the same rank." },
  { name: "Full House", cards: [11, 24, 37, 2, 41], blurb: "Three of a kind plus a pair." },
  { name: "Flush", cards: [39, 42, 44, 48, 50], blurb: "Five cards of one suit, any order." },
  { name: "Straight", cards: [3, 17, 31, 45, 7], blurb: "Five in a row, mixed suits." },
  { name: "Three of a Kind", cards: [9, 22, 35, 41, 6], blurb: "Three cards of the same rank." },
  { name: "Two Pair", cards: [7, 20, 1, 27, 11], blurb: "Two separate pairs." },
  { name: "One Pair", cards: [12, 25, 49, 31, 2], blurb: "Two cards of the same rank." },
  { name: "High Card", cards: [51, 22, 32, 3, 13], blurb: "No pair -- the highest card plays." },
];

interface RulesProps {
  onClose: () => void;
}

export function Rules({ onClose }: RulesProps) {
  return (
    <Modal title="How to play PikoPoker" onClose={onClose} wide>
      <section className="rules-section">
        <h3>Hand rankings, best to worst</h3>
        <div className="rules-hands">
          {HAND_RANKS.map((h) => (
            <div className="rules-hand-row" key={h.name}>
              <div className="card-row">
                {h.cards.map((c, i) => (
                  <PlayingCard key={i} card={c} small />
                ))}
              </div>
              <div className="rules-hand-text">
                <strong>{h.name}</strong>
                <span>{h.blurb}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rules-section">
        <h3>How a hand plays out</h3>
        <ol className="rules-list">
          <li>
            <strong>Blinds.</strong> The two seats after the dealer button post the small and big
            blind automatically -- everyone else acts for free pre-flop.
          </li>
          <li>
            <strong>Pre-Flop.</strong> Each player gets two private hole cards, then betting starts
            with the seat after the big blind.
          </li>
          <li>
            <strong>Flop, Turn, River.</strong> Three, then one, then one more shared community card
            hit the board, with a full round of betting after each.
          </li>
          <li>
            <strong>Showdown.</strong> Whoever's left makes their best 5-card hand from their two
            hole cards plus the five on the board. Best hand takes the pot; ties split it evenly.
          </li>
          <li>
            <strong>30 seconds to act.</strong> Miss the clock and you're auto-checked when it's
            free, auto-folded when it costs chips -- never auto-bet.
          </li>
        </ol>
      </section>

      <section className="rules-section">
        <h3>Buy-ins &amp; tables</h3>
        <p className="rules-p">
          Your buy-in is escrowed on-chain in the table's canister the moment you sit down --
          winnings move between seats instantly, no ledger call until you cash out with{" "}
          <em>Leave table</em>. Public tables run at fixed stakes; private tables let you set your
          own buy-in and invite friends with a link. A small rake (capped at a few big blinds) is
          taken from contested pots.
        </p>
      </section>
    </Modal>
  );
}
