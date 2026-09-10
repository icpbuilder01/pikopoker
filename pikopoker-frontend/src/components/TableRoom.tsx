import { useCallback, useEffect, useRef, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getLedgerActor, getPikopokerActor } from "../lib/actors";
import { pikopokerCanisterId, frontendUrl } from "../lib/canister-env";
import { formatPiko, parseAmount } from "../lib/format";
import { handLabel } from "../lib/handEval";
import { PlayingCard } from "./PlayingCard";
import { SeatCard } from "./SeatCard";
import { ChipAmount } from "./ChipAmount";
import { Confetti } from "./Confetti";
import { Rules } from "./Rules";
import { QrCode } from "./QrCode";
import { Phase, LeaveError, type ActionError, type JoinError, type TableView } from "../bindings/pikopoker/pikopoker";
import { isMuted, playCardSound, playChipSound, playFoldSound, playWinSound, setMuted } from "../lib/sound";

interface TableRoomProps {
  tableId: bigint;
  identity: Identity | null;
  privateCode?: string;
  onBack: () => void;
  onLogin: () => Promise<Identity | null>;
}

const POLL_MS = 700;
const ACTION_TIMEOUT_SECONDS = 30;

// The angle (radians) of seat `index` out of `total`, evenly spaced
// clockwise around the ellipse starting at the left -- matches the seat
// ordering the backend deals in, before any "put my seat at the bottom"
// rotation is applied.
function seatAngle(index: number, total: number): number {
  return (2 * Math.PI * index) / total - Math.PI;
}

// Kept inset from the true 50% radius (rx/ry below) so a seat card's own
// width/height doesn't push it past the felt-wrap edge on narrow (mobile)
// viewports. `.felt-wrap` switches from a 16:10 landscape oval to a taller
// 3:4 portrait one at the same 640px breakpoint (see App.css) -- the
// desktop radii are too large for that narrower shape, so `compact` picks
// smaller ones sized for the smallest phones this app supports (~320px
// wide).
function seatPosition(angle: number, compact: boolean): { top: string; left: string; dirX: number; dirY: number } {
  const rx = compact ? 36 : 44;
  const ry = compact ? 34 : 40;
  const left = 50 + rx * Math.cos(angle);
  const top = 50 + ry * Math.sin(angle);
  // Unit vector pointing from this seat back toward the felt's center --
  // used to nudge the bet pill inward, toward the pot, like a real table.
  const dirX = -Math.cos(angle);
  const dirY = -Math.sin(angle);
  return { top: `${top}%`, left: `${left}%`, dirX, dirY };
}

const pikopokerPrincipal = Principal.fromText(pikopokerCanisterId);

function phaseLabel(p: Phase): string {
  switch (p) {
    case Phase.WaitingForPlayers:
      return "Waiting for players";
    case Phase.PreFlop:
      return "Pre-Flop";
    case Phase.Flop:
      return "Flop";
    case Phase.Turn:
      return "Turn";
    case Phase.River:
      return "River";
    case Phase.Showdown:
      return "Showdown";
    default:
      return p;
  }
}

function joinErrorMessage(err: JoinError): string {
  switch (err.__kind__) {
    case "Anonymous":
      return "Log in to join.";
    case "AlreadySeatedAtTable":
      return "You're already seated at this table.";
    case "SeatOutOfRange":
      return "Invalid seat.";
    case "SeatTaken":
      return "Someone just took that seat -- try another.";
    case "WrongBuyInAmount":
      return "Buy-in amount mismatch.";
    case "TableNotFound":
      return "Table not found.";
    case "TransferFailed": {
      const inner = err.TransferFailed;
      if (inner.__kind__ === "InsufficientAllowance") return "Approval didn't cover the buy-in -- try again.";
      if (inner.__kind__ === "InsufficientFunds") return "Not enough PIKO balance to cover the buy-in.";
      return "Transfer failed -- try again.";
    }
    default:
      return "Couldn't join.";
  }
}

function leaveErrorMessage(err: LeaveError): string {
  switch (err) {
    case LeaveError.NotSeated:
      return "You're not seated here.";
    // StillInHand is no longer returned by the backend -- leaveTable now
    // queues instead (see the #Queued branch in handleLeave).
    case LeaveError.StillInHand:
      return "Couldn't leave.";
    case LeaveError.TransferFailed:
      return "Cash-out transfer failed -- your chips are safe, try leaving again in a moment.";
    default:
      return "Couldn't leave.";
  }
}

function actionErrorMessage(err: ActionError): string {
  switch (err.__kind__) {
    case "IllegalAction":
      return err.IllegalAction;
    case "NotSeated":
      return "You're not seated at this table.";
    case "NotYourTurn":
      return "It's not your turn.";
    case "NoHandInProgress":
      return "No hand in progress.";
    default:
      return "Action failed.";
  }
}

export function TableRoom({ tableId, identity, privateCode, onBack, onLogin }: TableRoomProps) {
  const [view, setView] = useState<TableView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [joiningSeat, setJoiningSeat] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [showTopUp, setShowTopUp] = useState(false);
  const [topUpInput, setTopUpInput] = useState("");
  const [raiseInput, setRaiseInput] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [showRules, setShowRules] = useState(false);
  const [showInviteQr, setShowInviteQr] = useState(false);
  const [confettiTrigger, setConfettiTrigger] = useState(0);
  const [leavePending, setLeavePending] = useState(false);
  const [showCustomBet, setShowCustomBet] = useState(false);
  // Mirrors App.css's `@media (max-width: 640px)` felt-wrap breakpoint --
  // seatPosition() needs to know which ellipse shape it's placing seats on.
  const [isCompact, setIsCompact] = useState(() => window.matchMedia("(max-width: 640px)").matches);
  const lastTurnKeyRef = useRef<string>("");
  const prevStackRef = useRef<bigint | null>(null);
  const prevResultRef = useRef<string | undefined>(undefined);
  const prevSoundViewRef = useRef<TableView | null>(null);
  const [muted, setMutedState] = useState(() => isMuted());

  const refresh = useCallback(async () => {
    try {
      const v = await getPikopokerActor(identity ?? undefined).getTableView(tableId);
      setView(v);
      setLoadError(v ? null : "Table not found.");
    } catch (err) {
      console.error("Failed to load table view", err);
    }
  }, [tableId, identity]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- polling on-chain state, not derived
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const onChange = () => setIsCompact(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const myPrincipalText = identity ? identity.getPrincipal().toText() : null;

  // Infer a win purely from my own stack going up right as a result posts --
  // the backend only exposes a human-readable lastResult string, no
  // structured per-seat payout, so this is a heuristic, not ground truth.
  useEffect(() => {
    if (!view || !myPrincipalText) return;
    const seat = view.seats.find((s) => s.occupant?.toText() === myPrincipalText);
    if (!seat) {
      prevStackRef.current = null;
      prevResultRef.current = view.lastResult;
      return;
    }
    if (
      view.lastResult !== undefined &&
      view.lastResult !== prevResultRef.current &&
      prevStackRef.current !== null &&
      seat.stack > prevStackRef.current
    ) {
      setConfettiTrigger((n) => n + 1);
      playWinSound();
    }
    prevStackRef.current = seat.stack;
    prevResultRef.current = view.lastResult;
  }, [view, myPrincipalText]);

  // Sound cues, driven purely by observing what changed between polls --
  // works the same whether it was my action or an opponent's, with no need
  // to hook every individual action handler. Skipped on the very first
  // view (nothing "changed" yet, would otherwise fire a sound barrage the
  // moment the table loads).
  useEffect(() => {
    if (!view) return;
    const prev = prevSoundViewRef.current;
    if (prev) {
      if (view.handNumber !== prev.handNumber) playCardSound(2);
      if (view.board.length > prev.board.length) playCardSound(view.board.length - prev.board.length);
      const committedNow = view.seats.reduce((sum, s) => sum + s.committedThisRound, 0n);
      const committedBefore = prev.seats.reduce((sum, s) => sum + s.committedThisRound, 0n);
      if (committedNow > committedBefore) playChipSound();
      const newlyFolded = view.seats.some((s, i) => s.hasFolded && !prev.seats[i]?.hasFolded);
      if (newlyFolded) playFoldSound();
    }
    prevSoundViewRef.current = view;
  }, [view]);
  const mySeatIndex = view
    ? view.seats.findIndex((s) => myPrincipalText !== null && s.occupant?.toText() === myPrincipalText)
    : -1;
  const mySeat = view && mySeatIndex >= 0 ? view.seats[mySeatIndex] : null;
  // Derived, not synchronized via effect: once the seat is actually vacant
  // (leave finalized, or this is simply a fresh seat) there's nothing
  // pending to show, regardless of stale local state from an earlier visit.
  const showLeavePending = leavePending && mySeat !== null;
  const isMyTurn =
    view !== null &&
    mySeatIndex >= 0 &&
    view.actingSeat !== undefined &&
    Number(view.actingSeat) === mySeatIndex &&
    view.phase !== Phase.WaitingForPlayers &&
    view.phase !== Phase.Showdown;

  const turnKey = view ? `${view.handNumber}-${view.actingSeat ?? "none"}` : "";
  useEffect(() => {
    if (isMyTurn && view && turnKey !== lastTurnKeyRef.current) {
      setRaiseInput(formatPiko(view.minRaiseTo));
      setShowCustomBet(false);
    }
    lastTurnKeyRef.current = turnKey;
  }, [turnKey, isMyTurn, view]);

  async function ensureIdentity(): Promise<Identity | null> {
    if (identity) return identity;
    return onLogin();
  }

  async function handleJoinSeat(seatIndex: number) {
    setActionError(null);
    const id = await ensureIdentity();
    if (!id || !view) return;
    if (view.kind.__kind__ === "Private" && !privateCode) {
      setActionError("You need an invite link with a code to join this private table.");
      return;
    }
    setJoiningSeat(seatIndex);
    try {
      // A 0 buyIn is the play-money "Free Play" table -- no real PIKO
      // moves, so there's nothing to approve (see pikopoker/src/main.mo's
      // doJoin, which skips the ledger entirely for it).
      if (view.buyIn > 0n) {
        const ledger = getLedgerActor(id);
        const fee = await ledger.icrc1_fee();
        const approveResult = await ledger.icrc2_approve({
          spender: { owner: pikopokerPrincipal },
          amount: view.buyIn + fee,
        });
        if (approveResult.__kind__ === "Err") {
          setActionError(`Approval failed: ${JSON.stringify(approveResult.Err)}`);
          return;
        }
      }
      const pikopoker = getPikopokerActor(id);
      const joinResult =
        view.kind.__kind__ === "Private"
          ? await pikopoker.joinPrivateTable(privateCode!, BigInt(seatIndex))
          : await pikopoker.joinPublicTable(tableId, BigInt(seatIndex));
      if (joinResult.__kind__ === "Err") {
        setActionError(joinErrorMessage(joinResult.Err));
      } else {
        setLeavePending(false);
        await refresh();
      }
    } catch (err) {
      console.error("Join failed", err);
      setActionError("Join failed -- try again.");
    } finally {
      setJoiningSeat(null);
    }
  }

  async function handleLeave() {
    if (!identity) return;
    setActionError(null);
    setBusy(true);
    try {
      const result = await getPikopokerActor(identity).leaveTable(tableId);
      if (result.__kind__ === "Err") {
        setActionError(leaveErrorMessage(result.Err));
      } else if (result.__kind__ === "Queued") {
        // Still contesting the pot -- the backend will auto-fold this seat
        // the instant it's its turn, then actually vacate it once the hand
        // ends (a few seconds after), no further action needed here.
        setLeavePending(true);
        await refresh();
      } else {
        setLeavePending(false);
        await refresh();
      }
    } catch (err) {
      console.error("Leave failed", err);
      setActionError("Leave failed -- try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelLeave() {
    if (!identity) return;
    setActionError(null);
    setBusy(true);
    try {
      const result = await getPikopokerActor(identity).cancelLeaveRequest(tableId);
      if (result.__kind__ === "Err") {
        setActionError(leaveErrorMessage(result.Err));
      } else {
        setLeavePending(false);
        await refresh();
      }
    } catch (err) {
      console.error("Cancel leave failed", err);
      setActionError("Couldn't cancel -- try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleSitOut(next: boolean) {
    if (!identity) return;
    setActionError(null);
    setBusy(true);
    try {
      const result = await getPikopokerActor(identity).sitOut(tableId, next);
      if (result.__kind__ === "Err") {
        setActionError(actionErrorMessage(result.Err));
      } else {
        await refresh();
      }
    } catch (err) {
      console.error("Sit out toggle failed", err);
      setActionError("Couldn't update sit-out status.");
    } finally {
      setBusy(false);
    }
  }

  async function handleTopUp() {
    const amount = parseAmount(topUpInput);
    if (!identity || amount === null) return;
    setActionError(null);
    setBusy(true);
    try {
      const ledger = getLedgerActor(identity);
      const fee = await ledger.icrc1_fee();
      const approveResult = await ledger.icrc2_approve({
        spender: { owner: pikopokerPrincipal },
        amount: amount + fee,
      });
      if (approveResult.__kind__ === "Err") {
        setActionError(`Approval failed: ${JSON.stringify(approveResult.Err)}`);
        return;
      }
      const result = await getPikopokerActor(identity).topUpStack(tableId, amount);
      if (result.__kind__ === "Err") {
        setActionError(joinErrorMessage(result.Err));
      } else {
        setTopUpInput("");
        setShowTopUp(false);
        await refresh();
      }
    } catch (err) {
      console.error("Top up failed", err);
      setActionError("Top up failed -- try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleFold() {
    if (!identity) return;
    setActionError(null);
    setBusy(true);
    try {
      const result = await getPikopokerActor(identity).fold(tableId);
      if (result.__kind__ === "Err") setActionError(actionErrorMessage(result.Err));
      else await refresh();
    } catch (err) {
      console.error("Fold failed", err);
      setActionError("Fold failed -- try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCheckCall() {
    if (!identity) return;
    setActionError(null);
    setBusy(true);
    try {
      const result = await getPikopokerActor(identity).checkOrCall(tableId);
      if (result.__kind__ === "Err") setActionError(actionErrorMessage(result.Err));
      else await refresh();
    } catch (err) {
      console.error("Check/call failed", err);
      setActionError("Action failed -- try again.");
    } finally {
      setBusy(false);
    }
  }

  async function submitRaise(amount: bigint | null) {
    if (!identity || amount === null) {
      setActionError("Enter a valid amount.");
      return;
    }
    setActionError(null);
    setBusy(true);
    try {
      const result = await getPikopokerActor(identity).betOrRaiseTo(tableId, amount);
      if (result.__kind__ === "Err") setActionError(actionErrorMessage(result.Err));
      else await refresh();
    } catch (err) {
      console.error("Raise failed", err);
      setActionError("Action failed -- try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRaise() {
    await submitRaise(parseAmount(raiseInput));
  }

  async function handleCopyInvite() {
    if (!privateCode) return;
    const link = `${frontendUrl}?table=${tableId.toString()}&code=${privateCode}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Copy failed", err);
    }
  }

  const owe = view && mySeat && view.currentBet > mySeat.committedThisRound ? view.currentBet - mySeat.committedThisRound : 0n;

  const secondsLeft =
    view && view.actionDeadline !== undefined
      ? Math.max(0, Math.round((Number(view.actionDeadline / 1_000_000n) - now) / 1000))
      : null;

  const timerProgress = secondsLeft !== null ? secondsLeft / ACTION_TIMEOUT_SECONDS : undefined;
  const isFree = view?.buyIn === 0n;
  const unit = isFree ? "chips" : "PIKO";
  const myHandLabel = handLabel(mySeat?.holeCards, view?.board ?? []);

  // Bet sizing -- all in e8s-scale bigints, converted to plain numbers only
  // for the <input type="range"> which can't take bigint (safe: even the
  // largest private-table buy-in, 1,000,000 PIKO, is ~1e14, well under
  // Number.MAX_SAFE_INTEGER).
  const maxAllInAmount = mySeat ? mySeat.committedThisRound + mySeat.stack : 0n;
  const minRaiseFloor = view ? (maxAllInAmount < view.minRaiseTo ? maxAllInAmount : view.minRaiseTo) : 0n;
  const potTotal = view ? view.pots.reduce((sum, p) => sum + p.amount, 0n) : 0n;
  // Standard "pot-sized bet" approximation: the pot as it'll look right
  // after you call, i.e. what a bet equal to the (post-call) pot means.
  const potForSizing = potTotal + owe;
  function clampBet(v: bigint): bigint {
    if (v < minRaiseFloor) return minRaiseFloor;
    if (v > maxAllInAmount) return maxAllInAmount;
    return v;
  }
  const potPreset = clampBet(mySeat ? mySeat.committedThisRound + owe + potForSizing : 0n);
  const halfPotPreset = clampBet(mySeat ? mySeat.committedThisRound + owe + potForSizing / 2n : 0n);

  const sliderMin = Number(minRaiseFloor);
  const sliderMax = Math.max(Number(maxAllInAmount), sliderMin);
  const sliderStep = view ? Math.max(1, Number(view.smallBlind)) : 1;
  const parsedRaise = parseAmount(raiseInput);
  const sliderValue = Math.min(Math.max(parsedRaise !== null ? Number(parsedRaise) : sliderMin, sliderMin), sliderMax);

  return (
    <div className="table-room">
      <Confetti trigger={confettiTrigger} />
      {showRules && <Rules onClose={() => setShowRules(false)} />}

      <div className="table-room-header">
        <button className="button secondary small" onClick={onBack}>
          &larr; Lobby
        </button>
        <div className="table-room-title">
          <h1>{view?.name ?? "Loading table..."}</h1>
          {view && (
            <span>
              {isFree ? "Free play" : view.kind.__kind__ === "Private" ? "Private" : "Public"} &middot;{" "}
              {formatPiko(view.smallBlind)}/{formatPiko(view.bigBlind)} blinds &middot;{" "}
              {isFree ? "no real PIKO" : `${formatPiko(view.buyIn)} PIKO buy-in`}
            </span>
          )}
        </div>
        <div className="table-room-header-actions">
          <button
            className="button secondary small"
            onClick={() => {
              const next = !muted;
              setMuted(next);
              setMutedState(next);
            }}
          >
            {muted ? "Sound: Off" : "Sound: On"}
          </button>
          <button className="button secondary small" onClick={() => setShowRules(true)}>
            Rules
          </button>
          {view && view.kind.__kind__ === "Private" && privateCode && (
            <>
              <button className="button secondary small" onClick={handleCopyInvite}>
                {copied ? "Copied!" : "Copy invite link"}
              </button>
              <button className="button secondary small" onClick={() => setShowInviteQr((v) => !v)}>
                {showInviteQr ? "Hide QR" : "Show QR"}
              </button>
            </>
          )}
        </div>
      </div>

      {showInviteQr && view && view.kind.__kind__ === "Private" && privateCode && (
        <div className="my-seat-bar join-seat-form">
          <div className="qr-box">
            <QrCode
              value={`${frontendUrl}?table=${tableId.toString()}&code=${privateCode}`}
              size={160}
              label="Table invite QR code"
            />
          </div>
          <p className="empty-state">Scan to open an invite link straight to this table.</p>
        </div>
      )}

      {loadError && <p className="error-text">{loadError}</p>}

      {view && (
        <>
          <div className="felt-wrap">
            <div className="felt" />
            <div className="felt-center">
              <span className="felt-phase">
                {phaseLabel(view.phase)} &middot; Hand #{view.handNumber.toString()}
              </span>
              {view.phase === Phase.WaitingForPlayers && (
                <span className="felt-hint">
                  {view.seats.filter((s) => s.occupant && !s.sittingOut).length < 2
                    ? `Deals itself in automatically once 2 players are seated -- up to ${view.seats.length} can play.`
                    : "Next hand starting..."}
                </span>
              )}
              <div className="felt-board">
                {Array.from(view.board).map((card, i) => (
                  <PlayingCard key={i} card={card} />
                ))}
              </div>
              {view.pots.length > 0 && (
                // Keyed by the total so the whole block remounts -- and its
                // CSS entrance animation replays -- every time the pot
                // actually grows, a small "chips landing" cue.
                <div className="felt-pots" key={potTotal.toString()}>
                  {view.pots.map((pot, i) => (
                    <span
                      className="felt-pot"
                      key={i}
                      title={
                        view.pots.length > 1
                          ? "A side pot forms when a player goes all-in for less than the others -- they can only win up to this pot, the rest is between whoever's left."
                          : undefined
                      }
                    >
                      {view.pots.length > 1 ? (i === 0 ? "Main pot: " : `Side pot ${i}: `) : "Pot: "}
                      <ChipAmount amount={pot.amount} unit={unit} size={12} />
                    </span>
                  ))}
                </div>
              )}
              {view.lastResult && <span className="felt-result">{view.lastResult}</span>}
            </div>

            {(() => {
              // On mobile, once you're seated, empty seats are just
              // clutter -- there's no reason to reserve room for 5 empty
              // circles when only 2-3 people are playing, and it's what
              // was crowding pot pills/phase text into the seats around
              // them. Newcomers deciding where to sit still see all 8 (an
              // empty seat is how they join a specific one), and desktop
              // always shows all 8 regardless -- there's room to spare.
              const hideEmpty = isCompact && mySeatIndex >= 0;
              const entries = view.seats
                .map((seat, i) => ({ seat, i }))
                .filter(({ seat }) => !hideEmpty || seat.occupant);
              const total = entries.length;
              // Rotate the whole (possibly filtered) ring so the viewer's
              // own seat always lands exactly at the bottom-center angle,
              // closest to the bet controls -- relative (clockwise) order
              // among the shown seats is preserved, matching standard
              // poker-client convention. Computed as a continuous angle
              // offset (not a discrete slot lookup) so this lands exactly
              // at the bottom for ANY seat count, not just multiples of 4
              // -- needed now that "total" varies with how many seats are
              // actually shown, not just the fixed 8. Seats stay in their
              // default order when you're not seated.
              const myPos = entries.findIndex(({ i }) => i === mySeatIndex);
              const angleOffset = myPos >= 0 ? Math.PI / 2 - seatAngle(myPos, total) : 0;
              return entries.map(({ seat, i }, pos_i) => {
                const angle = seatAngle(pos_i, total) + angleOffset;
                const pos = seatPosition(angle, isCompact);
                return (
                  <div className="seat-slot" style={{ top: pos.top, left: pos.left }} key={i}>
                    <SeatCard
                      seat={seat}
                      seatIndex={i}
                      isDealer={Number(view.dealerSeat) === i}
                      isActing={view.actingSeat !== undefined && Number(view.actingSeat) === i}
                      isMe={myPrincipalText !== null && seat.occupant?.toText() === myPrincipalText}
                      joining={joiningSeat === i}
                      canJoin={mySeatIndex === -1 && joiningSeat === null}
                      timerProgress={timerProgress}
                      unit={unit}
                      betDir={{ x: pos.dirX, y: pos.dirY }}
                      onJoin={() => handleJoinSeat(i)}
                    />
                  </div>
                );
              });
            })()}
          </div>

          {mySeat && (
            <div className="my-seat-bar">
              <span className="my-seat-stat">
                Your stack:{" "}
                <strong>
                  <ChipAmount amount={mySeat.stack} unit={unit} size={12} />
                </strong>
              </span>
              {myHandLabel && <span className="hand-indicator">{myHandLabel}</span>}
              <div className="my-seat-actions">
                <button className="button secondary small" disabled={busy} onClick={() => handleSitOut(!mySeat.sittingOut)}>
                  {mySeat.sittingOut ? "Sit back in" : "Sit out next hand"}
                </button>
                {!isFree && view.phase === Phase.WaitingForPlayers && (
                  <button className="button secondary small" onClick={() => setShowTopUp((v) => !v)}>
                    Top up
                  </button>
                )}
                {showLeavePending ? (
                  <span className="leave-pending">
                    <span className="leave-pending-dot" />
                    Leaving after this hand...
                    <button className="button secondary small" disabled={busy} onClick={handleCancelLeave}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button className="button danger small" disabled={busy} onClick={handleLeave}>
                    {isFree ? "Leave (new chips next time)" : "Leave table"}
                  </button>
                )}
              </div>
            </div>
          )}

          {showTopUp && mySeat && (
            <div className="my-seat-bar join-seat-form">
              <p>Add more chips to your stack (only while waiting for the next hand).</p>
              <div className="raise-row">
                <input
                  className="input"
                  placeholder="Amount (PIKO)"
                  value={topUpInput}
                  onChange={(e) => setTopUpInput(e.target.value)}
                />
                <button className="button small" disabled={busy || parseAmount(topUpInput) === null} onClick={handleTopUp}>
                  Confirm
                </button>
              </div>
            </div>
          )}

          {isMyTurn && mySeat && (
            <div className="action-bar modern">
              <div className="bet-info-row">
                <div className="bet-info-tile">
                  <span className="bet-info-label">Pot</span>
                  <span className="bet-info-value">
                    <ChipAmount amount={potTotal} unit={unit} size={15} />
                  </span>
                </div>
                <div className={`bet-info-tile ${owe > 0n ? "owe" : ""}`}>
                  <span className="bet-info-label">To call</span>
                  <span className="bet-info-value">
                    {owe > 0n ? <ChipAmount amount={owe} unit={unit} size={15} /> : "Free"}
                  </span>
                </div>
                {secondsLeft !== null && (
                  <div className="bet-info-tile timer">
                    <span className="bet-info-label">Time left</span>
                    <span className="bet-info-value action-timer">{secondsLeft}s</span>
                  </div>
                )}
              </div>

              <div className="action-buttons">
                <button className="button danger" disabled={busy} onClick={handleFold}>
                  Fold
                </button>
                <button className="button good" disabled={busy} onClick={handleCheckCall}>
                  {owe === 0n ? (
                    "Check"
                  ) : (
                    <>
                      Call <ChipAmount amount={owe} unit={unit} size={12} />
                    </>
                  )}
                </button>
              </div>

              <div className="bet-presets">
                <span className="bet-presets-label">Or raise -- tap an amount to bet it right away</span>
                <div className="bet-presets-row">
                  <button className="button secondary bet-preset" disabled={busy} onClick={() => submitRaise(minRaiseFloor)}>
                    <span className="bet-preset-label">Min</span>
                    <ChipAmount amount={minRaiseFloor} unit={unit} size={11} />
                  </button>
                  <button className="button secondary bet-preset" disabled={busy} onClick={() => submitRaise(halfPotPreset)}>
                    <span className="bet-preset-label">&frac12; Pot</span>
                    <ChipAmount amount={halfPotPreset} unit={unit} size={11} />
                  </button>
                  <button className="button secondary bet-preset" disabled={busy} onClick={() => submitRaise(potPreset)}>
                    <span className="bet-preset-label">Pot</span>
                    <ChipAmount amount={potPreset} unit={unit} size={11} />
                  </button>
                  <button className="button secondary bet-preset" disabled={busy} onClick={() => submitRaise(maxAllInAmount)}>
                    <span className="bet-preset-label">All-in</span>
                    <ChipAmount amount={maxAllInAmount} unit={unit} size={11} />
                  </button>
                </div>
              </div>

              {!showCustomBet && (
                <button
                  type="button"
                  className="button secondary small bet-custom-toggle"
                  onClick={() => setShowCustomBet(true)}
                >
                  Choose a different amount
                </button>
              )}

              {showCustomBet && (
                <div className="bet-sizer">
                  <span className="bet-presets-label">Your amount</span>
                  <input
                    type="range"
                    className="bet-slider"
                    min={sliderMin}
                    max={sliderMax}
                    step={sliderStep}
                    value={sliderValue}
                    onChange={(e) => setRaiseInput(formatPiko(BigInt(Math.round(Number(e.target.value)))))}
                  />
                  <div className="bet-sizer-row">
                    <label className="bet-amount-input">
                      <input
                        className="input"
                        value={raiseInput}
                        inputMode="decimal"
                        onChange={(e) => setRaiseInput(e.target.value)}
                      />
                      <span className="bet-amount-unit">{unit}</span>
                    </label>
                    <button className="button bet-cta" disabled={busy} onClick={handleRaise}>
                      {view.currentBet === 0n ? "Bet" : "Raise"}{" "}
                      <ChipAmount amount={parsedRaise ?? 0n} unit={unit} size={12} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {actionError && <p className="error-text">{actionError}</p>}

          {!mySeat && view.kind.__kind__ === "Private" && !privateCode && (
            <p className="empty-state">
              This is a private table -- you need an invite link with the code to join a seat. You can still watch.
            </p>
          )}
        </>
      )}
    </div>
  );
}
