import type { SeatView } from "../bindings/pikopoker/pikopoker";
import { PlayingCard } from "./PlayingCard";
import { ChipAmount } from "./ChipAmount";
import { PikoIcon } from "./PikoIcon";
import { formatPiko, shortPrincipal } from "../lib/format";

interface SeatCardProps {
  seat: SeatView;
  seatIndex: number;
  isDealer: boolean;
  isActing: boolean;
  isMe: boolean;
  joining: boolean;
  canJoin: boolean;
  timerProgress?: number; // 1 = just acted (full time left), 0 = about to time out
  unit: string;
  // Unit vector from this seat toward the felt's center -- nudges the bet
  // pill inward, toward the pot, like a real table.
  betDir: { x: number; y: number };
  onJoin: () => void;
}

function principalHue(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}

export function SeatCard({
  seat,
  seatIndex,
  isDealer,
  isActing,
  isMe,
  joining,
  canJoin,
  timerProgress,
  unit,
  betDir,
  onJoin,
}: SeatCardProps) {
  if (!seat.occupant) {
    return (
      <div className="seat-card empty">
        <div className="seat-avatar-slot" />
        <span className="seat-empty-label">Seat {seatIndex + 1} &middot; Empty</span>
        {canJoin && (
          <button className="button small" disabled={joining} onClick={onJoin}>
            {joining ? "Joining..." : "Join"}
          </button>
        )}
      </div>
    );
  }

  const principalText = seat.occupant.toText();
  const classes = ["seat-card"];
  if (isActing) classes.push("acting");
  if (seat.hasFolded) classes.push("folded");
  if (isMe) classes.push("me");

  return (
    <div className={classes.join(" ")}>
      {isActing && timerProgress !== undefined && (
        <div className="seat-timer-track">
          <div className="seat-timer-bar" style={{ width: `${Math.max(0, Math.min(1, timerProgress)) * 100}%` }} />
        </div>
      )}
      <div className="seat-identity">
        <span className="seat-avatar" style={{ background: `hsl(${principalHue(principalText)} 55% 40%)` }}>
          {isDealer && <span className="dealer-button" title="Dealer">D</span>}
          {principalText.slice(0, 2).toUpperCase()}
        </span>
        {seat.inHand && (
          <div className="card-row seat-cards">
            <PlayingCard card={seat.holeCards ? seat.holeCards[0] : undefined} small />
            <PlayingCard card={seat.holeCards ? seat.holeCards[1] : undefined} small />
          </div>
        )}
        <div className="seat-namepill">
          <div className="seat-name">{isMe ? "You" : shortPrincipal(principalText)}</div>
          <div className="seat-stack">
            <ChipAmount amount={seat.stack} unit={unit} size={11} />
          </div>
        </div>
      </div>
      <div className="seat-tags">
        {isMe && <span className="seat-tag you">YOU</span>}
        {seat.isAllIn && <span className="seat-tag allin">ALL-IN</span>}
        {seat.sittingOut && <span className="seat-tag">SITTING OUT</span>}
        {seat.hasFolded && <span className="seat-tag">FOLDED</span>}
      </div>
      {seat.committedThisRound > 0n && (
        <div className="chip-badge" style={{ transform: `translate(${betDir.x * 16}px, ${betDir.y * 14}px)` }}>
          {unit === "PIKO" ? <PikoIcon size={11} /> : <span className="chip-dot" />}
          {formatPiko(seat.committedThisRound)}
        </div>
      )}
    </div>
  );
}
