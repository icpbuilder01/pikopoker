import { useCallback, useEffect, useRef, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getLedgerActor, getPikopokerActor } from "../lib/actors";
import { pikopokerCanisterId, frontendUrl } from "../lib/canister-env";
import { formatPiko, parseAmount, shortPrincipal } from "../lib/format";
import { compareHandScore, evaluateBest, handLabel, labelForScore } from "../lib/handEval";
import { PlayingCard } from "./PlayingCard";
import { SeatCard } from "./SeatCard";
import { ChipAmount } from "./ChipAmount";
import { Confetti } from "./Confetti";
import { Rules } from "./Rules";
import { QrCode } from "./QrCode";
import { TableChat } from "./TableChat";
import {
  Phase,
  LeaveError,
  type ActionError,
  type JoinError,
  type SeatView,
  type TableView,
} from "../bindings/pikopoker/pikopoker";
import { isMuted, playDealSound, playFlipSound, playChipSound, playFoldSound, playWinSound, setMuted } from "../lib/sound";

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
//
// 2026-09-10: `liftMe` pulls the viewer's own seat further in specifically
// -- real bug, found via testing (not reported): even at every OTHER
// seat's card size, the "me" seat's own stack (avatar + hole cards + name
// pill + the extra "YOU" tag none of the other seats render) is taller
// than a normal seat, and since it's always rotated to exactly the
// bottom-center angle, that extra height was poking past the felt-wrap's
// own outer edge -- confirmed via getBoundingClientRect (~40-50px past,
// independent of any card-size change, present even at the original
// shipped card size). Every other seat is untouched (same rx/ry as
// always); only the one seat that's ever this tall gets extra headroom.
//
// 2026-09-11: `feltHeightPx` fixes a second, more general version of the
// same class of bug -- reported live as text overlapping the header above
// the table, reproduced via Playwright at a deliberately short viewport
// (375x667): with 2 seats occupied, the seat directly opposite "me"
// always lands exactly at the TOP extreme (sin(angle) = -1, same margin
// from the edge "me" gets at the bottom, but without any of "me"'s extra
// lift), and `ry`'s margin is a fixed PERCENTAGE of the felt's height --
// while a seat card's real height is roughly fixed in PIXELS. A narrow
// phone's felt (width-driven via a fixed aspect-ratio, see App.css) can
// still be short enough that the same percentage margin isn't enough
// absolute pixels, and the seat card's top half renders outside
// `.felt-wrap` entirely, overlapping whatever sits above it. Fixed
// generally rather than with another hand-tuned percentage: given the
// felt's actual rendered pixel height (read via a plain ResizeObserver on
// `.felt-wrap` itself, see `feltWrapHeight` below -- CSS computes the
// size, this just reads it back), clamp the seat's computed vertical
// center so it can never sit closer to either edge than half a seat
// card's real worst-case height. Only engages on compact/mobile, where
// the felt can actually get this short.
//
// The margin itself is smaller for every OTHER seat than for "me": "me"'s
// own card (avatar + full-size hole cards + name pill + the YOU tag) is
// much taller (~150px), but pushing an opponent's much shorter card
// (~70px once the @container-felt shrink above applies) out by that same
// generous margin only shoves it further from the edge and INTO
// felt-center's own space instead of away from it -- confirmed by
// measurement while fixing this: a shared 80px margin cleared the header
// but reproduced the exact same overlap one layer further in, against
// felt-center. Use the smallest margin each seat actually needs.
//
// 2026-09-15: tried bumping this constant to 115 first to fix a real
// reported felt-center/own-cards collision -- WRONG DIRECTION. This
// clamp's whole job is pulling a seat back IN when it's too close to the
// felt's OUTER edge (its ceiling is `100 - marginPct`, i.e. it only ever
// pulls "me" toward center, never pushes it away). A bigger constant
// here pulls "me" MORE toward center, the wrong direction when the
// actual problem is felt-center's own content growing tall enough to
// reach down toward "me" -- confirmed by measurement: a 35px-larger
// constant moved "me"'s cards by only ~6px, the wrong way. Left at its
// original, still-correct 80; the fix that actually worked is `ry`'s own
// liftMe trim below.
const SEAT_CARD_HALF_HEIGHT_ME_PX = 80;
const SEAT_CARD_HALF_HEIGHT_OTHER_PX = 46;
function seatPosition(
  angle: number,
  compact: boolean,
  liftMe: boolean,
  feltHeightPx?: number,
): { top: string; left: string; dirX: number; dirY: number } {
  const rx = compact ? 36 : 44;
  // 2026-09-15: compact liftMe trimmed 6 -> 1 -- real bug, reproduced via
  // measurement. A genuine Showdown grows felt-center tall enough (phase
  // label + board + a pot pill + a result pill, all at once) to reach
  // down into "me"'s own hole cards at mobile's tight felt height --
  // pulling "me" this far IN toward center was too much once felt-center
  // needs real room too, not just clearance from the felt's own outer
  // edge (the original 2026-09-10 problem this lift was built for, still
  // handled by the feltHeightPx clamp below regardless of this trim).
  // Verified live after trimming: a real all-in showdown at 390x844 went
  // from a ~6px overlap to ~19px of clear gap (felt-result's own bottom
  // edge vs "me"'s hole cards, measured via getBoundingClientRect), with
  // "me" still 33px clear of the felt's own bottom edge -- the original
  // overflow this lift prevents didn't come back either.
  const ry = (compact ? 34 : 40) - (liftMe ? (compact ? 1 : 9) : 0);
  const left = 50 + rx * Math.cos(angle);
  let top = 50 + ry * Math.sin(angle);
  if (feltHeightPx && feltHeightPx > 0) {
    const halfHeightPx = liftMe ? SEAT_CARD_HALF_HEIGHT_ME_PX : SEAT_CARD_HALF_HEIGHT_OTHER_PX;
    const marginPct = (halfHeightPx / feltHeightPx) * 100;
    top = Math.min(Math.max(top, marginPct), 100 - marginPct);
  }
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

// The backend's lastResult is just "Won uncontested"/"Showdown complete" --
// no winner or hand, since it's meant as a human-facing status string, not
// structured data. Hole cards are only revealed to every viewer for a
// genuine multi-way Showdown (backend gates on isRealShowdown(t.id), not
// just phase -- see seatView's revealCards in main.mo, fixed 2026-09-15);
// an uncontested win reveals nobody's cards but the winner's own, same as
// a real table where an uncontested winner is never required to show. So
// for an uncontested win this just falls through to view.lastResult below
// (contestants.length === 0, since nobody but the winner has any
// holeCards to look at) -- except from the winner's OWN client, where
// their own cards are still visible to themselves and this still builds a
// "You won uncontested with X" line, which is fine: showing your own
// result to yourself isn't the leak this was fixed for. Reused from a
// single seat's card comparison hook already used for the "what do I
// have" indicator, but with the full kicker-aware scorer (see
// handEval.ts's own comment) since this needs to agree with how the
// backend really settles the pot, not just label a category.
function showdownSummary(view: TableView, myPrincipalText: string | null): string | null {
  if (view.phase !== Phase.Showdown) return null;
  const contestants = view.seats.filter((s) => s.inHand && !s.hasFolded && s.holeCards);
  if (contestants.length === 0) return null;

  const nameFor = (s: SeatView) => {
    const text = s.occupant?.toText();
    if (!text) return "?";
    return text === myPrincipalText ? "You" : shortPrincipal(text);
  };

  if (contestants.length === 1) {
    const s = contestants[0];
    const label = handLabel(s.holeCards, view.board);
    return label ? `${nameFor(s)} won uncontested with ${label}` : `${nameFor(s)} won uncontested`;
  }

  const board = Array.from(view.board);
  const scored = contestants
    .map((s) => ({ s, score: evaluateBest([...s.holeCards!, ...board]) }))
    .filter((x): x is { s: SeatView; score: NonNullable<typeof x.score> } => x.score !== null);
  if (scored.length === 0) return null;

  let best = scored[0].score;
  for (const x of scored) {
    if (compareHandScore(x.score, best) > 0) best = x.score;
  }
  const winners = scored.filter((x) => compareHandScore(x.score, best) === 0);
  const label = labelForScore(best);
  const names = winners.map((w) => nameFor(w.s)).join(" & ");
  return winners.length > 1 ? `${names} split it with ${label}` : `${names} won with ${label}`;
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
      // Also covers a same-account lock from a very recent join/leave/top-up
      // still finishing up, not just a real ledger hiccup -- either way this
      // clears itself within a few seconds normally.
      if (inner.__kind__ === "TemporarilyUnavailable") return "Still finishing your last action -- wait a few seconds and try again.";
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
  // 2026-09-12: the whole "fit everything in one screen without scrolling"
  // design (this used to chase the felt's leftover flex-grow space via a
  // ResizeObserver on a separate `.felt-slot` wrapper, computing an
  // explicit pixel width/height every time any sibling UI element changed
  // height) is gone -- the dev asked directly for PikoPoker's table to
  // stop resizing at all, pointing at PikoBlackjack's table as the model:
  // it never fights for exact leftover space, it just renders at its own
  // natural size on an ordinary scrolling page, so it never has anything
  // to resize in response to. `.felt-wrap` now sizes itself purely via
  // CSS (`width: 100%` + a fixed `aspect-ratio`, see App.css) -- nothing
  // computes or sets its size in JS anymore, so it can no longer resize
  // just because the action bar's height changed, the header wrapped
  // differently, or a ResizeObserver callback fired mid-scroll. The one
  // thing still measured here is the felt's own rendered height in
  // pixels, purely to feed seatPosition()'s edge-overlap clamp (see that
  // function's own comment) -- reading the ALREADY-CSS-COMPUTED size,
  // never setting one.
  const feltWrapRef = useRef<HTMLDivElement | null>(null);
  const [feltWrapHeight, setFeltWrapHeight] = useState<number | null>(null);
  const viewLoaded = view !== null;
  useEffect(() => {
    const el = feltWrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setFeltWrapHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
    // `viewLoaded` (not `view` itself, which would re-run this every
    // 700ms poll): `.felt-wrap` only exists once `view` has loaded, so an
    // effect run before the first load finds the ref still null and never
    // gets a second chance to attach without this -- same lesson as the
    // felt-slot ResizeObserver this replaces.
  }, [viewLoaded]);
  const lastTurnKeyRef = useRef<string>("");
  // 2026-09-15: real bug reported live -- comparing against whatever
  // stack a poll happened to observe last (poll-to-poll delta, ~700ms
  // apart) is a race against how fast a hand can actually resolve. An
  // all-in has no further action once called -- the board runs out and
  // the hand resolves in the SAME update call, no awaits in between -- so
  // an entire hand (deal -> all-in -> showdown) can complete faster than
  // one polling interval, and the loser's own stack could be compared
  // against a stale pre-hand snapshot instead of their actual all-in low
  // point. Keyed off handNumber instead: the baseline is fixed to
  // whatever this seat's stack was the FIRST time this specific hand's
  // number was observed (i.e. right after blinds, before any further
  // betting), so the comparison no longer depends on which polls
  // happened to land where -- only on which hand is being compared.
  const handStartStackRef = useRef<{ handNumber: bigint; stack: bigint } | null>(null);
  const prevResultRef = useRef<string | undefined>(undefined);
  const prevSoundViewRef = useRef<TableView | null>(null);
  const [muted, setMutedState] = useState(() => isMuted());

  const refresh = useCallback(async () => {
    try {
      const v = await getPikopokerActor(identity ?? undefined).getTableView(tableId, privateCode ?? null);
      setView(v);
      setLoadError(v ? null : "Table not found.");
    } catch (err) {
      console.error("Failed to load table view", err);
    }
  }, [tableId, identity, privateCode]);

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

  // Nudges a stuck table toward the next hand without anyone having to
  // click anything. triggerDeal (a real client-initiated update call) is
  // proven reliable -- join and sitting back in both already use it --
  // but the backend timer alone can't always get there on its own, and
  // requiring a player action to kick it meant a table with two people
  // already seated, just waiting between hands, could sit stuck
  // indefinitely. Keeps nudging every few seconds for as long as this
  // client is seated and active, rather than backend timer surgery --
  // safer, and works as long as at least one seated player has the table
  // open, which is the common case. triggerDeal no-ops fast when there's
  // nothing to do, so this is cheap even when it's not needed.
  //
  // 2026-09-10: also active during Showdown, not just WaitingForPlayers.
  // Real incident -- a backend timer freeze (still not fully root-caused)
  // left a table stuck showing "Showdown complete" forever, and this
  // nudge being scoped to WaitingForPlayers only meant it never fired to
  // help: triggerDeal on the backend now also runs the Showdown cleanup
  // first (see its own comment), but that only helps if something is
  // actually calling it during Showdown too. Same reasoning as before --
  // nudging can't hurt on a table that's fine, and closes off the one
  // remaining "stuck with no client-side recovery at all" gap.
  //
  // 2026-09-25: the backend now wakes itself exactly when a table has
  // something due (see armWake in pikopoker/src/main.mo), so this nudge is
  // only a safety net -- slowed from 3s to 10s (each call is a paid update,
  // ~10M cycles). Added alongside it: nudge as soon as the acting player's
  // deadline is >3s overdue, which is exactly what a stuck backend timer
  // looks like from here; costs nothing while the backend is healthy.
  const nudgeStateRef = useRef<{ active: boolean; overdue: boolean; identity: Identity | null }>({
    active: false,
    overdue: false,
    identity: null,
  });
  useEffect(() => {
    const active = !!(
      identity &&
      view &&
      myPrincipalText &&
      (view.phase === Phase.WaitingForPlayers || view.phase === Phase.Showdown) &&
      view.seats.some((s) => s.occupant?.toText() === myPrincipalText && !s.sittingOut)
    );
    const overdue = !!(view && view.actionDeadline !== undefined && now > Number(view.actionDeadline / 1_000_000n) + 3000);
    nudgeStateRef.current = { active, overdue, identity };
  }, [identity, view, myPrincipalText, now]);

  useEffect(() => {
    let lastNudge = 0;
    const id = setInterval(() => {
      const { active, overdue, identity: nudgeIdentity } = nudgeStateRef.current;
      const since = Date.now() - lastNudge;
      if ((overdue && since >= 3000) || (active && nudgeIdentity && since >= 10000)) {
        lastNudge = Date.now();
        getPikopokerActor(nudgeIdentity ?? undefined)
          .triggerDeal(tableId)
          .catch(() => {});
      }
    }, 1000);
    return () => clearInterval(id);
  }, [tableId]);

  // Infer a win purely from my own stack going up right as a result posts --
  // the backend only exposes a human-readable lastResult string, no
  // structured per-seat payout, so this is a heuristic, not ground truth.
  // See handStartStackRef's own comment above on why the baseline is keyed
  // to handNumber rather than the previous poll's raw stack value.
  useEffect(() => {
    if (!view || !myPrincipalText) return;
    const seat = view.seats.find((s) => s.occupant?.toText() === myPrincipalText);
    if (!seat) {
      handStartStackRef.current = null;
      prevResultRef.current = view.lastResult;
      return;
    }
    if (!handStartStackRef.current || handStartStackRef.current.handNumber !== view.handNumber) {
      handStartStackRef.current = { handNumber: view.handNumber, stack: seat.stack };
    }
    if (
      view.lastResult !== undefined &&
      view.lastResult !== prevResultRef.current &&
      seat.stack > handStartStackRef.current.stack
    ) {
      setConfettiTrigger((n) => n + 1);
      playWinSound();
    }
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
      // 2026-09-15: split -- a new hand is hole cards being DEALT (slide +
      // soft land, still face-down for everyone but "me"), a growing
      // board is community cards being FLIPPED face-up (sharp snap). See
      // sound.ts's own comment on why these are now different cues.
      if (view.handNumber !== prev.handNumber) playDealSound(2);
      if (view.board.length > prev.board.length) playFlipSound(view.board.length - prev.board.length);
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
        // 2026-09-15: a real cash-out leave can land its payout in
        // pendingPayouts if the ledger transfer fails (see doLeave's own
        // refundOrQueue call) -- sweep it right away instead of leaving it
        // for the App-level login-time claim or a manual footer click, so
        // a real-money leave never LOOKS stuck even for the few seconds
        // until the next auto-sweep. Best-effort, silent: a normal leave
        // (or Free Play, which never touches payouts at all) just finds
        // nothing to claim.
        getPikopokerActor(identity).claimPendingPayout().catch(() => {});
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

  // Shared with both the seat-rendering map below AND the "is any seat
  // sitting close to the board's own height" check just below that --
  // hoisted out of the old per-render IIFE so both can use the exact same
  // entries/rotation, instead of a second inline computation risking
  // drifting out of sync with it.
  //
  // On mobile, once you're seated, empty seats are just clutter -- there's
  // no reason to reserve room for 5 empty circles when only 2-3 people are
  // playing, and it was crowding pot pills/phase text into the seats
  // around them. Newcomers deciding where to sit still see all 8 (an
  // empty seat is how they join a specific one), and desktop always shows
  // all 8 regardless -- there's room to spare.
  const hideEmpty = isCompact && mySeatIndex >= 0;
  const seatEntries = view
    ? view.seats.map((seat, i) => ({ seat, i })).filter(({ seat }) => !hideEmpty || seat.occupant)
    : [];
  const seatTotal = seatEntries.length;
  // Rotate the whole (possibly filtered) ring so the viewer's own seat
  // always lands exactly at the bottom-center angle, closest to the bet
  // controls -- relative (clockwise) order among the shown seats is
  // preserved, matching standard poker-client convention. Computed as a
  // continuous angle offset (not a discrete slot lookup) so this lands
  // exactly at the bottom for ANY seat count, not just multiples of 4 --
  // needed since `seatTotal` varies with how many seats are actually
  // shown, not just the fixed 8. Seats stay in their default order when
  // you're not seated.
  const myPos = seatEntries.findIndex(({ i }) => i === mySeatIndex);
  const seatAngleOffset = myPos >= 0 ? Math.PI / 2 - seatAngle(myPos, seatTotal) : 0;
  // 2026-09-12: real bug, reported live -- the dev asked directly whether
  // opponent avatars can land in the middle, on top of the board, once
  // there are "more than 4 players." Reproduced: the OLD guard here
  // (`occupied seats >= 7`) was a count-based proxy for a purely
  // GEOMETRIC condition -- a seat overlaps the board only when its own
  // angle puts it close enough to the horizontal midline (small
  // |sin(angle)|) that its position lands at roughly the same height as
  // the board row, regardless of how many seats are occupied. Measured
  // directly: 5 occupied seats produced a real overlap (an opponent's
  // avatar AND cards sitting on top of the community board), proving seat
  // COUNT alone predicts this badly (whether any seat's angle happens to
  // fall near 0/180 depends on the count AND the rotation offset
  // together, which itself depends on which physical seat "me" occupies
  // -- not a smooth function of count at all). Replaced the count check
  // with the actual geometric one: true whenever any OTHER occupied
  // seat's computed angle has |sin| under this cutoff.
  //
  // Threshold picked empirically, not purely analytically -- an earlier
  // attempt at 0.4 (between the 5-seat failure's 0.309 and a 3-seat
  // success's 0.5) still missed a real 6-seat overlap measured afterward
  // at sin(30 deg) = 0.5 exactly, while an *earlier* 3-seat case at that
  // same 0.5 angle had been fine: the board's own current pixel width
  // (which varies with how many community cards are showing, 0/3/4/5)
  // also genuinely matters, not just the angle, so no fixed angle cutoff
  // is perfectly exact either way. Raised to 0.6 -- covers every
  // overlap actually measured this session with real margin, at the cost
  // of occasionally shrinking the board a little at a seat count that
  // might have been fine anyway (e.g. 3-handed can now trigger it too) --
  // a strictly better trade than the reverse (missing a real overlap),
  // and the shrunk board still reads fine on its own (see the many-seats
  // CSS, already shipped and screenshotted for the 7-8 seat case).
  const hasNearHorizontalSeat = seatEntries.some(
    ({ i }, pos_i) => i !== mySeatIndex && Math.abs(Math.sin(seatAngle(pos_i, seatTotal) + seatAngleOffset)) < 0.6,
  );

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
          {/* 2026-09-15: desktop gets a 3-column layout (chat | felt |
              betting panel) so the action bar sits beside the table
              instead of below it -- no more scrolling the page every
              turn. Mobile keeps the original stacked flow (table-layout
              collapses to a plain column below 641px, see App.css) and
              TableChat switches to a small floating toggle over the
              felt's bottom-right corner instead of a sidebar. */}
          <div className="table-layout">
            <TableChat tableId={tableId} identity={identity} myPrincipalText={myPrincipalText} privateCode={privateCode} />
            {/* 2026-09-11/12: real bug, confirmed via measurement -- a seat
              sitting close enough to the horizontal midline (small
              |sin(angle)|, see `hasNearHorizontalSeat`'s own comment
              above) lands at roughly the same height as the community
              board, and the board's own natural width (up to 5 cards, not
              clipped by felt-center's narrower declared width) reaches
              far enough to genuinely overlap that seat's avatar/cards.
              The "many-seats" class shrinks just the board cards for
              exactly this case -- named for its original 7-8-seat trigger,
              kept since the CSS/comments already reference it, but now
              driven by the real geometric condition instead of a seat-
              count proxy. */}
          <div className={`felt-wrap${hasNearHorizontalSeat ? " many-seats" : ""}`} ref={feltWrapRef}>
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
              {(() => {
                const result = showdownSummary(view, myPrincipalText) ?? view.lastResult;
                return result ? <span className="felt-result">{result}</span> : null;
              })()}
            </div>

            {(() => {
              // entries/total/angleOffset (as seatEntries/seatTotal/
              // seatAngleOffset) are hoisted above, shared with
              // `hasNearHorizontalSeat` -- see that comment for why.
              return seatEntries.map(({ seat, i }, pos_i) => {
                const angle = seatAngle(pos_i, seatTotal) + seatAngleOffset;
                const isMe = myPrincipalText !== null && seat.occupant?.toText() === myPrincipalText;
                const pos = seatPosition(angle, isCompact, isMe, feltWrapHeight ?? undefined);
                return (
                  <div className="seat-slot" style={{ top: pos.top, left: pos.left }} key={i}>
                    <SeatCard
                      seat={seat}
                      seatIndex={i}
                      isDealer={Number(view.dealerSeat) === i}
                      isActing={view.actingSeat !== undefined && Number(view.actingSeat) === i}
                      isMe={isMe}
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
            // 2026-09-12: this used to be two mutually-exclusive bars --
            // a small "my-seat-bar" (stack + sit-out/leave) outside your
            // turn, swapped for a much taller "action-bar" (bet info +
            // Fold/Check/presets) the instant it became your turn. That
            // swap was the actual cause of the table visibly jumping size
            // every time a turn changed (the felt used to flex-grow into
            // whatever height difference that left, see the removed
            // felt-slot/ResizeObserver machinery above) -- min-height
            // hacks tried to paper over it but never fully closed the gap.
            // the dev asked directly for the fix instead of another patch:
            // always render the same betting interface, just visually
            // greyed out and non-interactive outside your turn, matching
            // how PikoBlackjack's table never resizes because it never
            // swaps its own layout based on turn state either. One bar,
            // one height, always -- `isMyTurn` now only ever toggles a
            // `disabled`/dimmed look on the controls that are always
            // present in the DOM.
            <div className="action-bar modern">
              <div className="action-bar-seat-row">
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

              {showTopUp && (
                <div className="join-seat-form">
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

              <div className={`betting-controls${isMyTurn ? "" : " not-my-turn"}`} inert={!isMyTurn}>
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
                  <div className="bet-info-tile timer">
                    <span className="bet-info-label">Time left</span>
                    <span className="bet-info-value action-timer">{secondsLeft !== null ? `${secondsLeft}s` : "--"}</span>
                  </div>
                </div>

                <div className="action-buttons">
                  <button className="button danger" disabled={busy || !isMyTurn} onClick={handleFold}>
                    Fold
                  </button>
                  <button className="button good" disabled={busy || !isMyTurn} onClick={handleCheckCall}>
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
                    <button className="button secondary bet-preset" disabled={busy || !isMyTurn} onClick={() => submitRaise(minRaiseFloor)}>
                      <span className="bet-preset-label">Min</span>
                      <ChipAmount amount={minRaiseFloor} unit={unit} size={11} />
                    </button>
                    <button className="button secondary bet-preset" disabled={busy || !isMyTurn} onClick={() => submitRaise(halfPotPreset)}>
                      <span className="bet-preset-label">&frac12; Pot</span>
                      <ChipAmount amount={halfPotPreset} unit={unit} size={11} />
                    </button>
                    <button className="button secondary bet-preset" disabled={busy || !isMyTurn} onClick={() => submitRaise(potPreset)}>
                      <span className="bet-preset-label">Pot</span>
                      <ChipAmount amount={potPreset} unit={unit} size={11} />
                    </button>
                    <button className="button secondary bet-preset" disabled={busy || !isMyTurn} onClick={() => submitRaise(maxAllInAmount)}>
                      <span className="bet-preset-label">All-in</span>
                      <ChipAmount amount={maxAllInAmount} unit={unit} size={11} />
                    </button>
                  </div>
                </div>

                {!showCustomBet && (
                  <button
                    type="button"
                    className="button secondary small bet-custom-toggle"
                    disabled={!isMyTurn}
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
                      disabled={!isMyTurn}
                      onChange={(e) => setRaiseInput(formatPiko(BigInt(Math.round(Number(e.target.value)))))}
                    />
                    <div className="bet-sizer-row">
                      <label className="bet-amount-input">
                        <input
                          className="input"
                          value={raiseInput}
                          inputMode="decimal"
                          disabled={!isMyTurn}
                          onChange={(e) => setRaiseInput(e.target.value)}
                        />
                        <span className="bet-amount-unit">{unit}</span>
                      </label>
                      <button className="button bet-cta" disabled={busy || !isMyTurn} onClick={handleRaise}>
                        {view.currentBet === 0n ? "Bet" : "Raise"}{" "}
                        <ChipAmount amount={parsedRaise ?? 0n} unit={unit} size={12} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
          </div>

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
