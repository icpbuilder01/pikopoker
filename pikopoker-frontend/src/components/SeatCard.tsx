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
  onJoin,
}: SeatCardProps) {
  if (!seat.occupant) {
    return (
      <div className="seat-card empty">
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
      {isDealer && <span className="dealer-button" title="Dealer">D</span>}
      {isActing && timerProgress !== undefined && (
        <div className="seat-timer-track">
          <div className="seat-timer-bar" style={{ width: `${Math.max(0, Math.min(1, timerProgress)) * 100}%` }} />
        </div>
      )}
      <div className="seat-identity">
        <span className="seat-avatar" style={{ background: `hsl(${principalHue(principalText)} 55% 40%)` }}>
          {principalText.slice(0, 2).toUpperCase()}
        </span>
        <div className="seat-name">{isMe ? "You" : shortPrincipal(principalText)}</div>
      </div>
      <div className="seat-stack">
        <ChipAmount amount={seat.stack} unit={unit} size={11} />
      </div>
      {seat.inHand && (
        <div className="card-row seat-cards">
          <PlayingCard card={seat.holeCards ? seat.holeCards[0] : undefined} small />
          <PlayingCard card={seat.holeCards ? seat.holeCards[1] : undefined} small />
        </div>
      )}
      <div className="seat-tags">
        {isMe && <span className="seat-tag you">YOU</span>}
        {seat.isAllIn && <span className="seat-tag allin">ALL-IN</span>}
        {seat.sittingOut && <span className="seat-tag">SITTING OUT</span>}
        {seat.hasFolded && <span className="seat-tag">FOLDED</span>}
      </div>
      {seat.committedThisRound > 0n && (
        <div className="chip-badge">
          {unit === "PIKO" ? <PikoIcon size={11} /> : <span className="chip-dot" />}
          {formatPiko(seat.committedThisRound)}
        </div>
      )}
    </div>
  );
}
