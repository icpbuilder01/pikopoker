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
import { Phase, LeaveError, type ActionError, type JoinError, type TableView } from "../bindings/pikopoker/pikopoker";

interface TableRoomProps {
  tableId: bigint;
  identity: Identity | null;
  privateCode?: string;
  onBack: () => void;
  onLogin: () => Promise<Identity | null>;
}

const POLL_MS = 1500;
const ACTION_TIMEOUT_SECONDS = 30;

// Evenly spaced around the felt's ellipse -- seat 0 at the left, then
// clockwise, matching the seat ordering the backend deals in. Kept inset
// from the true 50% radius (rx/ry below) so a seat card's own width/height
// doesn't push it past the felt-wrap edge on narrow (mobile) viewports.
function seatPosition(
  index: number,
  total: number,
): { top: string; left: string; dirX: number; dirY: number } {
  const angle = (2 * Math.PI * index) / total - Math.PI;
  const rx = 44;
  const ry = 40;
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
    case LeaveError.StillInHand:
      return "You're still in this hand -- fold or wait for it to finish before leaving.";
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
  const [confettiTrigger, setConfettiTrigger] = useState(0);
  const lastTurnKeyRef = useRef<string>("");
  const prevStackRef = useRef<bigint | null>(null);
  const prevResultRef = useRef<string | undefined>(undefined);

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
    }
    prevStackRef.current = seat.stack;
    prevResultRef.current = view.lastResult;
  }, [view, myPrincipalText]);
  const mySeatIndex = view
    ? view.seats.findIndex((s) => myPrincipalText !== null && s.occupant?.toText() === myPrincipalText)
    : -1;
  const mySeat = view && mySeatIndex >= 0 ? view.seats[mySeatIndex] : null;
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
      } else {
        await refresh();
      }
    } catch (err) {
      console.error("Leave failed", err);
      setActionError("Leave failed -- try again.");
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

  async function handleRaise() {
    const amount = parseAmount(raiseInput);
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
          <button className="button secondary small" onClick={() => setShowRules(true)}>
            Rules
          </button>
          {view && view.kind.__kind__ === "Private" && privateCode && (
            <button className="button secondary small" onClick={handleCopyInvite}>
              {copied ? "Copied!" : "Copy invite link"}
            </button>
          )}
        </div>
      </div>

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
                <div className="felt-pots">
                  {view.pots.map((pot, i) => (
                    <span className="felt-pot" key={i}>
                      {view.pots.length > 1 ? `Pot ${i + 1}: ` : "Pot: "}
                      <ChipAmount amount={pot.amount} unit={unit} size={12} />
                    </span>
                  ))}
                </div>
              )}
              {view.lastResult && <span className="felt-result">{view.lastResult}</span>}
            </div>

            {view.seats.map((seat, i) => {
              const pos = seatPosition(i, view.seats.length);
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
            })}
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
                <button className="button danger small" disabled={busy} onClick={handleLeave}>
                  {isFree ? "Leave (new chips next time)" : "Leave table"}
                </button>
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

              <div className="bet-presets">
                <span className="bet-presets-label">Quick bet -- sets the amount below, still needs confirming</span>
                <div className="bet-presets-row">
                  <button className="button secondary bet-preset" onClick={() => setRaiseInput(formatPiko(minRaiseFloor))}>
                    <span className="bet-preset-label">Min</span>
                    <ChipAmount amount={minRaiseFloor} unit={unit} size={11} />
                  </button>
                  <button className="button secondary bet-preset" onClick={() => setRaiseInput(formatPiko(halfPotPreset))}>
                    <span className="bet-preset-label">&frac12; Pot</span>
                    <ChipAmount amount={halfPotPreset} unit={unit} size={11} />
                  </button>
                  <button className="button secondary bet-preset" onClick={() => setRaiseInput(formatPiko(potPreset))}>
                    <span className="bet-preset-label">Pot</span>
                    <ChipAmount amount={potPreset} unit={unit} size={11} />
                  </button>
                  <button className="button secondary bet-preset" onClick={() => setRaiseInput(formatPiko(maxAllInAmount))}>
                    <span className="bet-preset-label">All-in</span>
                    <ChipAmount amount={maxAllInAmount} unit={unit} size={11} />
                  </button>
                </div>
              </div>

              <div className="bet-sizer">
                <span className="bet-presets-label">Or choose your own amount</span>
                <input
                  type="range"
                  className="bet-slider"
                  min={sliderMin}
                  max={sliderMax}
                  step={sliderStep}
                  value={sliderValue}
                  onChange={(e) => setRaiseInput(formatPiko(BigInt(Math.round(Number(e.target.value)))))}
                />
                <label className="bet-amount-input">
                  <input
                    className="input"
                    value={raiseInput}
                    inputMode="decimal"
                    onChange={(e) => setRaiseInput(e.target.value)}
                  />
                  <span className="bet-amount-unit">{unit}</span>
                </label>
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
                <button className="button bet-cta" disabled={busy} onClick={handleRaise}>
                  {view.currentBet === 0n ? "Bet" : "Raise"}{" "}
                  <ChipAmount amount={parsedRaise ?? 0n} unit={unit} size={12} />
                </button>
              </div>
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
