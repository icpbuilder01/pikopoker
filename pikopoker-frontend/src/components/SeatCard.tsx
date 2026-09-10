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

// betDir points from this seat toward the felt's center. A negative y means
// the center is *above* this seat, i.e. the seat itself sits in the bottom
// half of the felt -- true for the viewer's own seat every time, now that
// it's always rotated to bottom-center. The dealer badge and action timer
// normally perch above the seat card, which is fine when there's open felt
// above them, but for a bottom seat that space is the felt-center content
// (phase/pot/result text) instead -- flipping them below the seat card
// there avoids the collision.
function badgesFlip(betDir: { y: number }): boolean {
  return betDir.y < 0;
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
  const flip = badgesFlip(betDir);
  const classes = ["seat-card"];
  if (isActing) classes.push("acting");
  if (seat.hasFolded) classes.push("folded");
  if (isMe) classes.push("me");

  const timerBar = timerProgress !== undefined && (
    <div className="seat-timer-bar" style={{ width: `${Math.max(0, Math.min(1, timerProgress)) * 100}%` }} />
  );

  return (
    <div className={classes.join(" ")}>
      {isActing && timerProgress !== undefined && !flip && <div className="seat-timer-track">{timerBar}</div>}
      {isDealer && (
        // A direct child of .seat-card, not nested inside the small
        // .seat-avatar -- see badgesFlip()'s own comment for why the
        // flipped case needs to clear more than the avatar's ~40px. Bigger
        // hole cards (see the mobile-card-size entry) made the flipped-
        // below position tall enough to occasionally push past the felt's
        // *own* bottom rail on a short-enough felt -- side-anchored here
        // instead, which is independent of the card's height entirely.
        <span className={`dealer-button${flip ? " flip" : ""}`} title="Dealer">
          D
        </span>
      )}
      <div className="seat-identity">
        <span className="seat-avatar" style={{ background: `hsl(${principalHue(principalText)} 55% 40%)` }}>
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
        <div
          className={`chip-badge${flip ? " flip" : ""}`}
          key={seat.committedThisRound.toString()}
          style={{
            // @ts-expect-error custom properties read by the keyframe in App.css
            "--bet-x": `${betDir.x * 16}px`,
            "--bet-y": `${betDir.y * 14}px`,
          }}
        >
          {unit === "PIKO" ? <PikoIcon size={11} /> : <span className="chip-dot" />}
          {formatPiko(seat.committedThisRound)}
        </div>
      )}
      {isActing && flip && (
        // Rendered in normal flow here instead of absolutely positioned
        // above/below the card (see badgesFlip()'s comment) -- a floated
        // position tall/short enough to clear both the felt-center content
        // above and the felt's own bottom rail below turned out not to
        // exist reliably once hole cards got bigger on some real devices.
        // Taking up its own real space in the card guarantees it never
        // overlaps anything else, at the cost of the card growing a few
        // px taller for the one seat (yours) that's always in the tightest
        // spot on the felt.
        <div className="seat-timer-track inline">{timerBar}</div>
      )}
    </div>
  );
}
