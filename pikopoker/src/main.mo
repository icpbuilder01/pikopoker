import Principal "mo:core/Principal";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Int "mo:core/Int";
import Text "mo:core/Text";
import Blob "mo:core/Blob";
import Time "mo:core/Time";
import Timer "mo:core/Timer";
import Map "mo:core/Map";
import Array "mo:core/Array";
import Iter "mo:core/Iter";
import VarArray "mo:core/VarArray";
import Runtime "mo:core/Runtime";
import Debug "mo:core/Debug";
import Error "mo:core/Error";
import Cards "cards";
import Types "types";

// PikoPoker: No-Limit Texas Hold'em, 6-max tables, bet in PIKO. Public
// tables (a few standing stakes, seeded at install) plus private tables
// (created on demand, joined by a share code) -- see README.
//
// Custody model: unlike PikoPay (a pure profile directory, no funds),
// a poker table fundamentally needs an escrow -- chips have to sit in a
// shared pot the canister controls while a hand is live. So this canister
// holds real PIKO, the same way `dice` holds a betting bankroll: buy-in
// pulls funds in via icrc2_transfer_from (the player approves this
// canister first), cash-out pays back out via icrc1_transfer. Winnings
// within a hand never touch the ledger at all -- the pot only moves
// between seats' in-canister stacks, since the PIKO is already sitting in
// this canister's own account from the buy-in.
//
// Fairness: cards are dealt from a deck shuffled with real randomness
// from the IC's own raw_rand (management canister), the same primitive
// `dice` already uses for its roll -- see dealNextHand. Hole cards are
// redacted from every query response except the caller's own seat (and
// everyone's, at showdown) -- see viewFor. That hides hands from other
// *players* through the public API; it is not confidential compute, a
// canister controller could in principle still inspect raw state. Same
// disclosed limitation this whole project already applies to itself
// (mother/dice aren't blackholed yet either) -- not hidden, just true of
// any IC canister today.
actor self {

  // ---- Ledger wiring ----
  // The real, live PIKO ledger by default -- same reasoning as dice's own
  // icpLedgerId: a fixed external dependency, not a same-project canister,
  // so it can't be resolved via PUBLIC_CANISTER_ID the way a real sibling
  // canister would be. Unlike dice's icpLedgerId (which ships with no
  // setter at all, "never redirectable post-launch"), this one keeps a
  // controller-only escape hatch specifically for pointing at the local
  // test-ledger during development, closed off for good by
  // lockPikoLedgerId() before this is ever trusted with real funds on
  // mainnet -- see ../scripts/deploy-local.sh for the local redirect.
  var pikoLedgerId : Principal = Principal.fromText("56aad-fiaaa-aaaaj-qsefa-cai");
  var pikoLedgerLocked : Bool = false;

  func requireController(caller : Principal) {
    if (not Principal.isController(caller)) {
      Runtime.trap("only a controller can call this");
    };
  };

  public shared ({ caller }) func setPikoLedgerId(id : Principal) : async () {
    requireController(caller);
    if (pikoLedgerLocked) { Runtime.trap("piko ledger id is permanently locked") };
    pikoLedgerId := id;
  };

  public shared ({ caller }) func lockPikoLedgerId() : async () {
    requireController(caller);
    pikoLedgerLocked := true;
  };

  func ledger() : Types.LedgerActor { actor (Principal.toText(pikoLedgerId)) };

  // ---- Constants ----
  let ACTION_TIMEOUT_NANOS : Int = 30 * 1_000_000_000;
  let HAND_PAUSE_NANOS : Int = 5 * 1_000_000_000;
  // 2026-09-12: how long a table can sit occupied-but-unable-to-play
  // (fewer than 2 active seats, so no hand can ever be dealt) before its
  // seat(s) are auto-vacated -- see soloIdleSince's own comment below.
  let SOLO_IDLE_TIMEOUT_NANOS : Int = 10 * 60 * 1_000_000_000;
  // 2026-09-16: how long a single SEAT may stay sittingOut (voluntary or
  // auto-triggered on a zero stack) before it's individually vacated --
  // distinct from SOLO_IDLE_TIMEOUT_NANOS above, which only fires when the
  // whole table has fewer than 2 active seats. A sittingOut seat sitting
  // next to 2+ other ACTIVE seats never trips that check (the table keeps
  // dealing hands fine without it) and never trips afkTimeouts either
  // (excluded from being dealt in, so it never gets a turn to time out) --
  // so it could occupy a seat forever, blocking a spot on an otherwise-full
  // table, with no automatic recovery at all until now.
  let SIT_OUT_TIMEOUT_NANOS : Int = 15 * 60 * 1_000_000_000;
  // Halved from 2s (2026-09-09) to shave the worst-case slack off every
  // timer-driven transition (action timeouts, the Showdown pause, dealing
  // the next hand) -- tick() itself is cheap when idle (a handful of Map
  // entries and comparisons, no awaits unless there's actually something
  // to do), so firing twice as often has no meaningful cycles impact.
  let TICK_INTERVAL_SECONDS : Nat = 1;
  // Standard capped rake: a share of the pot, never more than a few big
  // blinds -- keeps the house edge negligible on small pots the way real
  // rooms do it. Controller-adjustable like mother's miningFeeE8s (moves
  // cost for everyone equally, can't target anyone, low blast radius), no
  // timelock needed for the same reason.
  // No commission -- the whole PIKO family is subsidized by the mining
  // auto-top-up system, this site doesn't need to earn anything itself.
  // Still controller-adjustable (setRakeBps) if that ever changes.
  var rakeBps : Nat = 0;
  let rakeCapBigBlinds : Nat = 3;
  var rakeBalance : Nat = 0;
  // A table's buyIn of exactly 0 is the sentinel for a play-money table --
  // see doJoin/leaveTable/topUpStack, which special-case it to skip the
  // ledger entirely. FREE_CHIPS is the complimentary stack a seat gets on
  // sitting down; no real PIKO ever moves for this table.
  let FREE_CHIPS : Nat = 100_000_000_000; // 1,000 chips, same 8-decimal display as PIKO

  // ---- State ----
  var nextTableId : Nat = 0;
  // Guards the one-time "add 2 more free tables" migration below --
  // see its own comment for why this exists instead of a `nextTableId`
  // check.
  var freePlay2And3Seeded : Bool = false;
  // Guards the one-time "add a 4th free table" migration below, same
  // reasoning as freePlay2And3Seeded just above.
  var freePlay4Seeded : Bool = false;
  let tables : Map.Map<Nat, Types.Table> = Map.empty<Nat, Types.Table>();
  let privateCodes : Map.Map<Text, Nat> = Map.empty<Text, Nat>();
  // Locks concurrent join/leave/topUp calls from the same principal --
  // same reasoning as dice's pendingBets: set synchronously before the
  // first await so a burst of concurrent calls from one principal can't
  // interleave across the icrc2_transfer_from await.
  let pendingFundsActions : Map.Map<Principal, Bool> = Map.empty<Principal, Bool>();
  // 2026-09-12: real bug reported live, twice -- a principal locked out of
  // EVERY table (even Free Play, which never touches this map's callers at
  // all) with "Transfer failed -- try again." forever, needing a manual
  // `adminClearPendingFunds` each time. This map's own guard is exactly
  // the "self-call/external-call can hang, not just reject" class already
  // proven several times elsewhere in this file (tick()/tickWork(),
  // triggerDeal) -- except here the hang is in the real
  // `icrc2_transfer_from`/`icrc1_transfer` awaits inside doJoin/doLeave/
  // topUpStack themselves, which genuinely CANNOT be made fire-and-forget
  // the way tickWork()'s nudge could be (the caller's own result has to
  // reflect whether real funds actually moved). A canister upgrade mid-
  // flight is one concrete way this happens: Motoko cannot resume an
  // in-flight await across a reinstall/upgrade, so a join that was
  // awaiting the ledger's reply exactly when a new backend version got
  // deployed loses that continuation forever -- the lock it set survives
  // (it's stable state), but the code that would ever clear it does not
  // resume. Given how often this canister gets redeployed live, this is a
  // real, recurring risk, not a one-off.
  //
  // Fixed with a timestamp instead of a bare boolean, in a NEW top-level
  // map (safe-EOP pure addition, same pattern as afkTimeouts/pendingLeaves
  // -- pendingFundsActions itself is left as-is, only ever read/written
  // alongside this new map from now on, never given a new value type).
  // `isPendingFundsLocked` treats an entry as expired after
  // PENDING_FUNDS_TIMEOUT_NANOS, letting a fresh attempt through
  // automatically -- no more manual admin intervention needed for this
  // specific failure mode. A lock entry from BEFORE this upgrade (present
  // in `pendingFundsActions` but missing from this new map) is treated as
  // already-expired on sight, which also retroactively unsticks anyone
  // already stuck from a past incident the moment this deploys.
  let pendingFundsSince : Map.Map<Principal, Int> = Map.empty<Principal, Int>();
  let PENDING_FUNDS_TIMEOUT_NANOS : Int = 120 * 1_000_000_000;
  func isPendingFundsLocked(caller : Principal) : Bool {
    if (Map.get(pendingFundsActions, Principal.compare, caller) == null) { return false };
    switch (Map.get(pendingFundsSince, Principal.compare, caller)) {
      case null { false };
      case (?since) { Time.now() - since < PENDING_FUNDS_TIMEOUT_NANOS };
    };
  };
  func setPendingFunds(caller : Principal) {
    Map.add(pendingFundsActions, Principal.compare, caller, true);
    Map.add(pendingFundsSince, Principal.compare, caller, Time.now());
  };
  func clearPendingFunds(caller : Principal) {
    Map.remove(pendingFundsActions, Principal.compare, caller);
    Map.remove(pendingFundsSince, Principal.compare, caller);
  };
  // Seats that asked to leave while still un-folded in a live hand (can't
  // safely vacate mid-hand -- showdown logic needs the seat). Queued here
  // instead of erroring: auto-folded the instant it's their turn (see
  // setActing) and actually vacated + cashed out once the hand fully ends
  // (see tick()'s Showdown -> WaitingForPlayers reset). Keyed by table id
  // + principal since the same principal could be queued at several tables.
  let pendingLeaves : Map.Map<Text, Bool> = Map.empty<Text, Bool>();
  func leaveKey(tableId : Nat, p : Principal) : Text {
    Nat.toText(tableId) # "#" # Principal.toText(p);
  };
  // 2026-09-11: consecutive turns resolved by the action-timeout clock
  // rather than a real fold/checkOrCall/betOrRaiseTo from the seat's own
  // occupant -- a brand-new stable map, NOT a new field on the existing
  // `Types.Seat` record, on purpose: a first attempt adding `var
  // afkTimeouts : Nat` directly to `Seat` traps the canister outright on
  // upgrade ("RTS error: Memory-incompatible program upgrade") since
  // Motoko's enhanced orthogonal persistence has no way to synthesize a
  // value for that field on seat records already persisted before the
  // upgrade -- caught on the local network before ever touching mainnet.
  // A brand-new top-level map, same safe-EOP "pure addition" pattern as
  // `pendingLeaves`/`pendingFundsActions` above, sidesteps the problem
  // entirely (a lookup miss just means "0", exactly the right default
  // for every seat that existed before this feature). Keyed by table id
  // + SEAT INDEX (not principal): tied to the physical seat slot, so a
  // fresh occupant sitting down there never inherits a predecessor's
  // count (removed here on every leave, not just reset to 0 -- an absent
  // entry already means 0). Reset to absent by any real action from the
  // seat's own occupant; incremented by maybeEnforceActionTimeout; at 4,
  // the seat is force-vacated.
  let afkTimeouts : Map.Map<Text, Nat> = Map.empty<Text, Nat>();
  func afkKey(tableId : Nat, seatIndex : Nat) : Text {
    Nat.toText(tableId) # "#" # Nat.toText(seatIndex);
  };
  func getAfkTimeouts(tableId : Nat, seatIndex : Nat) : Nat {
    switch (Map.get(afkTimeouts, Text.compare, afkKey(tableId, seatIndex))) {
      case (?n) { n };
      case null { 0 };
    };
  };
  func resetAfkTimeouts(tableId : Nat, seatIndex : Nat) {
    Map.remove(afkTimeouts, Text.compare, afkKey(tableId, seatIndex));
  };
  func resetSittingOutSince(tableId : Nat, seatIndex : Nat) {
    Map.remove(sittingOutSince, Text.compare, afkKey(tableId, seatIndex));
  };
  // 2026-09-12: real bug reported live -- the dev found 2 of their own idle
  // accounts still occupying a table hours after they'd stopped playing.
  // Root cause: `afkTimeouts` above only ever counts turns resolved by a
  // LIVE HAND's own action-timeout, but `dealNextHand`'s own `active.size()
  // < 2` guard means no hand is EVER dealt while fewer than 2 seats are
  // active -- so a lone occupied seat (or several, if the occupant(s) are
  // sittingOut) never gets a turn to time out in the first place. That
  // combination -- occupied, phase stuck at WaitingForPlayers, active < 2
  // -- had no automatic recovery at all, only the manual controller-only
  // adminKickSeat. Confirmed live on mainnet: table 10 had exactly 1
  // occupied, non-sittingOut, non-inHand seat, stuck this way indefinitely.
  //
  // Same safe-EOP "pure top-level map addition" pattern as afkTimeouts/
  // pendingLeaves above: tableId -> the Time.now() this stuck state was
  // FIRST observed, cleared the instant the table recovers (a second
  // active seat joins or sits back in) so a normal short wait for a second
  // player is never penalized. After SOLO_IDLE_TIMEOUT_NANOS of
  // continuously being stuck this way, every currently-occupied seat is
  // vacated via the exact same `doLeave` a normal leave or admin kick
  // already uses. Always safe to vacate immediately here specifically
  // because phase == WaitingForPlayers means no seat is ever mid-hand
  // (`inHand` is always false) -- unlike the in-hand afkTimeouts case,
  // there's no auto-fold/auto-check distinction to make.
  let soloIdleSince : Map.Map<Nat, Int> = Map.empty<Nat, Int>();
  // 2026-09-16: per-SEAT counterpart to soloIdleSince above -- see
  // SIT_OUT_TIMEOUT_NANOS's own comment for the gap this closes. Same safe-
  // EOP "pure top-level map addition" pattern, keyed by table id + seat
  // index (afkKey, same key shape as afkTimeouts, tied to the physical
  // seat slot not the occupant). Set the instant a seat becomes
  // sittingOut (by the player's own sitOut(true) call, or automatically on
  // a zero stack at Showdown cleanup), cleared the instant it stops being
  // sittingOut (sitOut(false), or the seat is vacated) -- so a player who
  // only steps away briefly and comes back well within the window is never
  // penalized. Only ever consulted for a seat that is ALSO not `inHand`
  // (maybeCleanupSittingOutSeats' own check) -- a seat can be sittingOut
  // while still `inHand` (mid-hand toggle, see sitOut's own comment), and
  // vacating a live contestant out from under an in-progress hand would
  // wrongly delete their claim on the pot, same hazard afkTimeouts' own
  // auto-CHECK-must-queue distinction already exists to avoid.
  let sittingOutSince : Map.Map<Text, Int> = Map.empty<Text, Int>();
  // A failed payout (cash-out or, in principle, a refund) is recorded here
  // rather than silently lost -- retryable via claimPendingPayout, same
  // pattern mother/dice already use for a failed transfer after funds
  // logically left the game.
  let pendingPayouts : Map.Map<Principal, Nat> = Map.empty<Principal, Nat>();
  // Same pendingFundsActions/pendingLeaves pattern, for dealNextHand:
  // 2026-09-10, at least four independent things can now try to deal a
  // table (the timer, join, sitting back in, and a periodic nudge every
  // seated client's own tab sends every few seconds) -- the existing
  // post-raw_rand phase recheck only protects against ONE specific
  // overlap shape (a second call resuming after the first already
  // finished dealing). An explicit lock, set synchronously before the
  // only await and cleared on every exit path after that, rules out the
  // whole class of concurrent-dealing races regardless of exact shape or
  // trigger source -- suspected (not proven) to be involved in this
  // family's recurring "won uncontested, over and over, right from the
  // deal" incidents (2026-09-05, and reported again today).
  let dealingTables : Map.Map<Nat, Bool> = Map.empty<Nat, Bool>();

  // 2026-09-15: real bug reported live -- seatView's revealCards check
  // only ever tested `t.phase == #Showdown`, but BOTH endHandByFold
  // (everyone else folded, nobody chose to show) and endHandShowdown (a
  // real multi-way showdown) set that same phase -- so an uncontested
  // fold-win revealed the winner's cards to the very player who folded,
  // which real poker never does (a folded hand is mucked, and an
  // uncontested winner is never required to show either). New top-level
  // map, same safe-EOP "pure addition" pattern as pendingLeaves/
  // afkTimeouts/etc. above -- NOT a new field directly on `Types.Table`,
  // which would trap on upgrade for every table that already exists on
  // mainnet (see afkTimeouts' own comment on this exact class of
  // mistake). Present + true only after a genuine endHandShowdown;
  // absent (treated as false) otherwise, including the entire
  // WaitingForPlayers/PreFlop/Flop/Turn/River span of every hand.
  let realShowdownTables : Map.Map<Nat, Bool> = Map.empty<Nat, Bool>();
  func isRealShowdown(tableId : Nat) : Bool {
    Map.get(realShowdownTables, Nat.compare, tableId) == ?true;
  };

  // 2026-09-15: per-table chat, requested by the dev. Messages expire
  // after 24h to bound cycles/memory growth -- deliberately done by
  // LAZY filtering (on every read AND on every send, never via a Timer/
  // self-call) rather than a proactive cleanup job, specifically to avoid
  // adding another self-call to the already-fragile class of bug this
  // canister keeps hitting (tick()/triggerDeal, see the many 2026-09
  // entries above) -- a chat feature has no business risking that. An
  // idle table's stale messages just sit in stable memory unread/
  // unfiltered until the next send prunes them; the read path never
  // shows anything past CHAT_TTL_NANOS regardless of whether storage has
  // been pruned yet, so correctness never depends on the prune actually
  // running promptly.
  let tableChats : Map.Map<Nat, [Types.ChatMessage]> = Map.empty<Nat, [Types.ChatMessage]>();
  let CHAT_TTL_NANOS : Int = 24 * 60 * 60 * 1_000_000_000;
  let CHAT_MAX_MESSAGES : Nat = 200; // hard cap per table regardless of age, bounds worst-case memory
  let CHAT_MAX_MESSAGE_LEN : Nat = 240;

  func freshChatMessages(tableId : Nat) : [Types.ChatMessage] {
    let now = Time.now();
    switch (Map.get(tableChats, Nat.compare, tableId)) {
      case null { [] };
      case (?msgs) {
        Array.filter<Types.ChatMessage>(msgs, func(m) { now - m.timestamp < CHAT_TTL_NANOS });
      };
    };
  };

  func newSeats() : [Types.Seat] {
    Array.tabulate<Types.Seat>(
      Types.MAX_SEATS,
      func(_i) {
        {
          var occupant = null;
          var stack = 0;
          var holeCards = null;
          var committedThisRound = 0;
          var committedThisHand = 0;
          var hasFolded = false;
          var isAllIn = false;
          var inHand = false;
          var sittingOut = false;
        };
      },
    );
  };

  func newTable(id : Nat, name : Text, kind : Types.TableKind, buyIn : Nat, smallBlind : Nat, bigBlind : Nat) : Types.Table {
    {
      id;
      var name = name;
      kind;
      buyIn;
      smallBlind;
      bigBlind;
      seats = newSeats();
      var phase = #WaitingForPlayers;
      var board = [];
      var deck = [];
      var dealerSeat = 0;
      var actingSeat = null;
      var actionDeadline = null;
      var currentBet = 0;
      var minRaiseAmount = 0;
      var toAct = 0;
      var handNumber = 0;
      var lastResult = null;
      var nextHandAt = null;
    };
  };

  func createPublicTable(name : Text, buyIn : Nat) {
    let id = nextTableId;
    nextTableId += 1;
    let sb = buyIn / 200;
    let bb = buyIn / 100;
    Map.add(tables, Nat.compare, id, newTable(id, name, #Public, buyIn, sb, bb));
  };

  func createFreeTable(name : Text) {
    let id = nextTableId;
    nextTableId += 1;
    let sb = FREE_CHIPS / 200;
    let bb = FREE_CHIPS / 100;
    Map.add(tables, Nat.compare, id, newTable(id, name, #Public, 0, sb, bb));
  };

  // Seeded once at first install. NOTE: unlike a stable var's own
  // initializer (which enhanced orthogonal persistence correctly skips
  // re-running on upgrade), a bare top-level statement like these calls is
  // NOT skipped -- it re-executes on every single upgrade regardless of
  // persisted state, appending 4 duplicate tables each time. Learned this
  // the hard way on 2026-09-05: a routine backend upgrade silently doubled
  // the mainnet lobby to 8 tables. Guarded on `Map.size(tables) == 0` so
  // it only ever actually seeds on a genuine first install.
  if (Map.size(tables) == 0) {
    createPublicTable("Micro", 10_000_000_000); // 100 PIKO buy-in, 0.5/1 blinds
    createPublicTable("Low", 100_000_000_000); // 1,000 PIKO buy-in, 5/10 blinds
    createPublicTable("High", 1_000_000_000_000); // 10,000 PIKO buy-in, 50/100 blinds
    createFreeTable("Free Play"); // no real PIKO, 1,000 complimentary chips per sit-down
  };

  // 2026-09-12: two more free tables, added at the dev's request. Unlike
  // the table-TIER changes elsewhere in this file's history (buy-in/
  // blinds/MAX_SEATS are baked into each Table's immutable fields at
  // `newTable()` time, so changing them for EXISTING tables needs a full
  // reinstall), adding brand-new tables touches nothing about the
  // existing ones -- safe as a normal upgrade.
  //
  // First attempt guarded this on `nextTableId == 4` (the value right
  // after the original 4-table seed, before either of these existed) --
  // WRONG, caught on mainnet before it did any harm (just silently never
  // fired): real players had already created real private tables via
  // `createPrivateTable` over this canister's weeks of live use, each one
  // incrementing `nextTableId` past 4 long before this code ever ran, so
  // the guard was never true on the actual mainnet canister it needed to
  // run on -- it only ever worked in this session's own from-scratch
  // local tests, which never had any private tables to throw the count
  // off. Fixed with a dedicated stable flag instead, unambiguous
  // regardless of how many private (or, eventually, more free) tables
  // exist by the time this runs -- a pure addition, same safe-EOP pattern
  // as every other one-time migration flag in this file.
  if (not freePlay2And3Seeded) {
    createFreeTable("Free Play 2");
    createFreeTable("Free Play 3");
    freePlay2And3Seeded := true;
  };

  // 2026-09-18: a 4th free table, same reasoning/safety as the pair above
  // (pure addition, doesn't touch existing tables).
  if (not freePlay4Seeded) {
    createFreeTable("Free Play 4");
    freePlay4Seeded := true;
  };

  // ---- Views (hole cards redacted for everyone but the caller, except at showdown) ----

  func seatView(t : Types.Table, seat : Types.Seat, seatIndex : Nat, caller : Principal) : Types.SeatView {
    // 2026-09-14: real bug reported live -- a folded seat's holeCards are
    // never cleared on fold (only hasFolded is set, see fold()/finishAction
    // -Advance), so this used to reveal EVERY occupied seat's cards at
    // Showdown regardless of whether that seat actually folded before
    // reaching it. A folded hand is mucked, not shown -- only seats still
    // live at Showdown (didn't fold) should have their cards revealed to
    // everyone; the seat's own occupant can always see their own cards
    // either way, folded or not.
    //
    // 2026-09-15: real bug reported live, same area -- an UNCONTESTED win
    // (everyone else folds) also reaches phase == #Showdown (see
    // endHandByFold), so the fix above still revealed the winner's cards
    // to the very player who'd just folded -- real poker never requires
    // an uncontested winner to show. Added isRealShowdown(t.id): only a
    // genuine multi-way endHandShowdown sets it, so an uncontested win
    // now withholds cards from everyone but the winner themselves, same
    // as a real table where nobody asked to see a mucked/uncontested hand.
    let revealCards = switch (seat.occupant) {
      case (?o) { o == caller or (t.phase == #Showdown and isRealShowdown(t.id) and not seat.hasFolded) };
      case null { false };
    };
    {
      occupant = seat.occupant;
      stack = seat.stack;
      holeCards = if (revealCards) { seat.holeCards } else { null };
      committedThisRound = seat.committedThisRound;
      committedThisHand = seat.committedThisHand;
      hasFolded = seat.hasFolded;
      isAllIn = seat.isAllIn;
      inHand = seat.inHand;
      sittingOut = seat.sittingOut;
      afkTimeouts = getAfkTimeouts(t.id, seatIndex);
    };
  };

  func tableView(t : Types.Table, caller : Principal) : Types.TableView {
    {
      id = t.id;
      name = t.name;
      kind = t.kind;
      buyIn = t.buyIn;
      smallBlind = t.smallBlind;
      bigBlind = t.bigBlind;
      phase = t.phase;
      seats = Array.mapEntries<Types.Seat, Types.SeatView>(t.seats, func(s, i) { seatView(t, s, i, caller) });
      board = t.board;
      dealerSeat = t.dealerSeat;
      actingSeat = t.actingSeat;
      actionDeadline = t.actionDeadline;
      currentBet = t.currentBet;
      minRaiseTo = t.currentBet + t.minRaiseAmount;
      pots = computePots(t);
      handNumber = t.handNumber;
      lastResult = t.lastResult;
    };
  };

  // `code` only matters for a private table -- see canViewTable's own
  // comment for the real leak this closes. Public tables are unaffected
  // (pass null), same "watch free, log in to act" posture as ever.
  public shared query ({ caller }) func getTableView(tableId : Nat, code : ?Text) : async ?Types.TableView {
    switch (Map.get(tables, Nat.compare, tableId)) {
      case (?t) { if (canViewTable(t, caller, code)) { ?tableView(t, caller) } else { null } };
      case null { null };
    };
  };

  // Spectators can read/send without being seated, same "watch without
  // logging in, log in to act" posture as the rest of this canister --
  // redacts nothing beyond the membership/code gate itself. See
  // freshChatMessages' own comment above for why expiry is lazy rather
  // than timer-driven, and canViewTable's for why this gate exists at
  // all now (2026-09-15: was ungated, same leak class as getTableView).
  public shared query ({ caller }) func getTableChat(tableId : Nat, code : ?Text) : async [Types.ChatMessage] {
    switch (Map.get(tables, Nat.compare, tableId)) {
      case (?t) { if (canViewTable(t, caller, code)) { freshChatMessages(tableId) } else { [] } };
      case null { [] };
    };
  };

  public shared ({ caller }) func sendTableChat(tableId : Nat, text : Text, code : ?Text) : async {
    #Ok;
    #Err : Types.ChatError;
  } {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };
    let t = switch (Map.get(tables, Nat.compare, tableId)) {
      case null { return #Err(#TableNotFound) };
      case (?t) { t };
    };
    if (not canViewTable(t, caller, code)) { return #Err(#TableNotFound) };
    let trimmed = Text.trim(text, #char ' ');
    if (Text.size(trimmed) == 0) { return #Err(#EmptyMessage) };
    if (Text.size(trimmed) > CHAT_MAX_MESSAGE_LEN) { return #Err(#MessageTooLong) };
    let fresh = freshChatMessages(tableId);
    let appended = Array.concat<Types.ChatMessage>(fresh, [{ sender = caller; text = trimmed; timestamp = Time.now() }]);
    // Keep only the most recent CHAT_MAX_MESSAGES regardless of age -- a
    // hard cap independent of the 24h TTL, so a single very chatty table
    // can't grow unbounded within a day.
    let bounded = if (appended.size() > CHAT_MAX_MESSAGES) {
      Array.sliceToArray<Types.ChatMessage>(appended, appended.size() - CHAT_MAX_MESSAGES, appended.size());
    } else { appended };
    Map.add(tableChats, Nat.compare, tableId, bounded);
    #Ok;
  };

  public query func getLobby() : async [Types.TableSummary] {
    Array.map<Types.Table, Types.TableSummary>(
      Array.filter<Types.Table>(
        Array.map<(Nat, Types.Table), Types.Table>(Map.toArray(tables), func((_, t)) { t }),
        func(t) { switch (t.kind) { case (#Public) { true }; case (#Private _) { false } } },
      ),
      func(t) { summarize(t) },
    );
  };

  func summarize(t : Types.Table) : Types.TableSummary {
    var taken = 0;
    for (s in t.seats.vals()) { if (s.occupant != null) { taken += 1 } };
    {
      id = t.id;
      name = t.name;
      kind = t.kind;
      buyIn = t.buyIn;
      smallBlind = t.smallBlind;
      bigBlind = t.bigBlind;
      seatsTaken = taken;
      phase = t.phase;
    };
  };

  public shared query ({ caller }) func getMyPrivateTables() : async [Types.TableSummary] {
    let mine = Array.filter<(Nat, Types.Table)>(
      Map.toArray(tables),
      func((_, t)) {
        var seated = false;
        for (s in t.seats.vals()) { if (s.occupant == ?caller) { seated := true } };
        seated and (switch (t.kind) { case (#Private _) { true }; case (#Public) { false } });
      },
    );
    Array.map<(Nat, Types.Table), Types.TableSummary>(mine, func((_, t)) { summarize(t) });
  };

  // ---- Table creation (private, "with friends") ----

  func randomCode(seed : Nat) : Text {
    let alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/l/i, easy to read aloud
    let chars = Text.toArray(alphabet);
    var n = seed;
    var out = "";
    var i = 0;
    while (i < 6) {
      let idx = n % chars.size();
      n := n / chars.size();
      out #= Text.fromChar(chars[idx]);
      i += 1;
    };
    out;
  };

  public shared ({ caller }) func createPrivateTable(name : Text, buyIn : Nat) : async {
    #Ok : { id : Nat; code : Text };
    #Err : Types.CreatePrivateError;
  } {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };
    let trimmedName = Text.trim(name, #predicate(func(c) { c == ' ' }));
    if (Text.size(trimmedName) == 0 or Text.size(trimmedName) > 32) { return #Err(#InvalidName) };
    // 0 is the play-money sentinel (see FREE_CHIPS/Free Play's own comment)
    // -- the dev asked directly for private tables to support this too, so
    // friends can play a private free game together, not just real-money
    // ones. Any other out-of-range amount is still rejected.
    if (buyIn != 0 and (buyIn < 10_000_000_000 or buyIn > 100_000_000_000_000)) {
      return #Err(#InvalidBuyIn); // 100 PIKO .. 1,000,000 PIKO
    };
    // 2026-09-15: real vulnerability, found in a full security audit --
    // this used to seed the code from `id * 7919 + Time.now() % 1_000_000`,
    // NOT real randomness (unlike the deck shuffle below, which already
    // uses raw_rand correctly). `id` is a small sequential counter and the
    // time component was collapsed to at most 1,000,000 residues by the
    // modulo, so the actual reachable code space was tiny compared to the
    // nominal 32^6 alphabet -- guessable in practice by anyone narrowing
    // down roughly when a table was created. Fetched BEFORE any state
    // mutation, same reasoning as dealNextHand's own raw_rand call: this
    // is the only await in the function, so nothing below it needs a
    // post-await re-check (id/code assignment all happens synchronously
    // afterward, in one atomic step no other call's continuation can
    // interleave into).
    let Management : Types.ManagementActor = actor ("aaaaa-aa");
    let entropy = try { await Management.raw_rand() } catch (e) {
      Debug.print("createPrivateTable: raw_rand failed, caller=" # Principal.toText(caller) # " error=" # Error.message(e));
      return #Err(#TemporarilyUnavailable);
    };
    let id = nextTableId;
    nextTableId += 1;
    var code = randomCode(Cards.entropyToNat(Blob.toArray(entropy)));
    // Vanishingly unlikely with real 256-bit entropy, but don't hand out a
    // colliding code regardless.
    while (Map.get(privateCodes, Text.compare, code) != null) {
      code #= "x";
    };
    // A free table's blinds are derived from FREE_CHIPS (the complimentary
    // stack every seat gets), not from buyIn=0 itself -- same convention
    // createFreeTable already uses for the public Free Play table.
    let (sb, bb) = if (buyIn == 0) { (FREE_CHIPS / 200, FREE_CHIPS / 100) } else { (buyIn / 200, buyIn / 100) };
    Map.add(tables, Nat.compare, id, newTable(id, trimmedName, #Private({ code }), buyIn, sb, bb));
    Map.add(privateCodes, Text.compare, code, id);
    #Ok({ id; code });
  };

  // ---- Join / leave / top up (the only funds-moving entry points) ----

  func findTableByCode(code : Text) : ?Types.Table {
    switch (Map.get(privateCodes, Text.compare, Text.toLower(Text.trim(code, #predicate(func(c) { c == ' ' }))))) {
      case (?id) { Map.get(tables, Nat.compare, id) };
      case null { null };
    };
  };

  func isSeatedAt(t : Types.Table, p : Principal) : Bool {
    for (s in t.seats.vals()) { if (s.occupant == ?p) { return true } };
    false;
  };

  func normalizeCode(code : Text) : Text {
    Text.toLower(Text.trim(code, #predicate(func(c) { c == ' ' })));
  };

  // 2026-09-15: real vulnerability, found in a full security audit and
  // fixed the same session -- getTableView/getTableChat/sendTableChat
  // took only a bare tableId, no membership or code check at all, and
  // TableView.kind echoes `t.kind` UNCHANGED -- for a private table
  // that's `#Private({ code })`, so the actual invite code was handed
  // back in plaintext to literally anyone who queried that table id.
  // Table ids are small sequential integers (0, 1, 2, ...), trivial to
  // enumerate with no privilege at all -- so the entire "private, invite-
  // only" model was bypassable by anyone willing to loop over a few
  // hundred ids, both for reading a private table's full live state
  // (board, bets, results, and everyone's hole cards at showdown) and
  // for lifting its code to actually join and play with real PIKO.
  // Public tables are unaffected -- this canister's whole design is
  // "watch free, log in to act", and that's preserved exactly; only a
  // private table's own privacy boundary was broken. Fixed by gating on
  // either being seated at the table already, or presenting the correct
  // code -- same normalization (trim + lowercase) findTableByCode
  // already uses for joining, so a viewer can paste the code in any
  // case/with stray whitespace the same way a joiner already could.
  func canViewTable(t : Types.Table, caller : Principal, code : ?Text) : Bool {
    switch (t.kind) {
      case (#Public) { true };
      case (#Private({ code = realCode })) {
        isSeatedAt(t, caller) or (
          switch (code) {
            case (?c) { normalizeCode(c) == realCode };
            case null { false };
          }
        );
      };
    };
  };

  func doJoin(t : Types.Table, seatIndex : Nat, caller : Principal) : async* {
    #Ok : ();
    #Err : Types.JoinError;
  } {
    if (seatIndex >= t.seats.size()) { return #Err(#SeatOutOfRange) };
    let seat = t.seats[seatIndex];
    if (seat.occupant != null) { return #Err(#SeatTaken) };
    if (isSeatedAt(t, caller)) { return #Err(#AlreadySeatedAtTable) };

    if (t.buyIn == 0) {
      // Play-money table -- no real funds move, so no await/re-check race
      // is even possible here; just hand out a complimentary stack.
      seat.occupant := ?caller;
      seat.stack := FREE_CHIPS;
      return #Ok(());
    };

    let Ledger = ledger();
    let result = try {
      await Ledger.icrc2_transfer_from({
        spender_subaccount = null;
        from = { owner = caller; subaccount = null };
        to = { owner = Principal.fromActor(self); subaccount = null };
        amount = t.buyIn;
        fee = null;
        memo = null;
        created_at_time = null;
      });
    } catch (e) {
      Debug.print("doJoin: icrc2_transfer_from REJECTED, caller=" # Principal.toText(caller) # " table=" # debug_show (t.id) # " amount=" # debug_show (t.buyIn) # " error=" # Error.message(e));
      #Err(#TemporarilyUnavailable);
    };
    switch (result) {
      case (#Err(e)) {
        Debug.print("doJoin: icrc2_transfer_from returned Err, caller=" # Principal.toText(caller) # " table=" # debug_show (t.id) # " amount=" # debug_show (t.buyIn) # " error=" # debug_show (e));
      };
      case (#Ok(_)) {};
    };

    switch (result) {
      case (#Ok(_)) {
        // Re-check the seat is still free -- the transfer's await gave up
        // the synchronous prefix's exclusivity, another join for the same
        // seat could have landed while this one was in flight.
        if (seat.occupant != null) {
          // Refund: the seat filled while we were waiting on the transfer.
          await refundOrQueue(caller, t.buyIn);
          return #Err(#SeatTaken);
        };
        seat.occupant := ?caller;
        seat.stack := t.buyIn;
        #Ok(());
      };
      case (#Err(e)) { #Err(#TransferFailed(e)) };
    };
  };

  func refundOrQueue(to : Principal, amount : Nat) : async () {
    let Ledger = ledger();
    let result = try {
      await Ledger.icrc1_transfer({
        from_subaccount = null;
        to = { owner = to; subaccount = null };
        amount;
        fee = null;
        memo = null;
        created_at_time = null;
      });
    } catch (_e) { #Err(#TemporarilyUnavailable) };
    switch (result) {
      case (#Ok(_)) {};
      case (#Err(_)) {
        let current = switch (Map.get(pendingPayouts, Principal.compare, to)) {
          case (?n) { n };
          case null { 0 };
        };
        Map.add(pendingPayouts, Principal.compare, to, current + amount);
      };
    };
  };

  public shared ({ caller }) func joinPublicTable(tableId : Nat, seatIndex : Nat) : async {
    #Ok : ();
    #Err : Types.JoinError;
  } {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };
    if (isPendingFundsLocked(caller)) {
      return #Err(#TransferFailed(#TemporarilyUnavailable));
    };
    setPendingFunds(caller);
    let outcome = switch (Map.get(tables, Nat.compare, tableId)) {
      case null { #Err(#TableNotFound) };
      case (?t) {
        let r = await* doJoin(t, seatIndex, caller);
        // 2026-09-10: a real bug, found live -- this self-call failing
        // uncaught (cycles shortage, or the same self-call flakiness
        // noted on triggerDeal's own comment) used to skip the
        // Map.remove below entirely, permanently locking that principal
        // out of ever joining ANY table again (every future join hits
        // the pendingFundsActions guard above and returns
        // TransferFailed/TemporarilyUnavailable forever). The deal
        // trigger is a nice-to-have on top of an already-successful
        // join, never worth losing the join over.
        //
        // 2026-09-12: that fix only ever covered a REJECTED self-call --
        // a HUNG one (see nudgeDeal's own comment) skipped Map.remove
        // just the same, since a direct `await` never returns either
        // way. Switched to `nudgeDeal`, which can't block this function
        // at all regardless of what triggerDeal does.
        if (r == #Ok(())) { ignore nudgeDeal(t.id) };
        r;
      };
    };
    clearPendingFunds(caller);
    outcome;
  };

  public shared ({ caller }) func joinPrivateTable(code : Text, seatIndex : Nat) : async {
    #Ok : ();
    #Err : Types.JoinError;
  } {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };
    if (isPendingFundsLocked(caller)) {
      return #Err(#TransferFailed(#TemporarilyUnavailable));
    };
    setPendingFunds(caller);
    let outcome = switch (findTableByCode(code)) {
      case null { #Err(#TableNotFound) };
      case (?t) {
        let r = await* doJoin(t, seatIndex, caller);
        // 2026-09-10: a real bug, found live -- this self-call failing
        // uncaught (cycles shortage, or the same self-call flakiness
        // noted on triggerDeal's own comment) used to skip the
        // Map.remove below entirely, permanently locking that principal
        // out of ever joining ANY table again (every future join hits
        // the pendingFundsActions guard above and returns
        // TransferFailed/TemporarilyUnavailable forever). The deal
        // trigger is a nice-to-have on top of an already-successful
        // join, never worth losing the join over.
        //
        // 2026-09-12: that fix only ever covered a REJECTED self-call --
        // a HUNG one (see nudgeDeal's own comment) skipped Map.remove
        // just the same, since a direct `await` never returns either
        // way. Switched to `nudgeDeal`, which can't block this function
        // at all regardless of what triggerDeal does.
        if (r == #Ok(())) { ignore nudgeDeal(t.id) };
        r;
      };
    };
    clearPendingFunds(caller);
    outcome;
  };

  func findSeat(t : Types.Table, caller : Principal) : ?Nat {
    var i = 0;
    while (i < t.seats.size()) {
      if (t.seats[i].occupant == ?caller) { return ?i };
      i += 1;
    };
    null;
  };

  public shared ({ caller }) func leaveTable(tableId : Nat) : async {
    #Ok : Nat;
    #Queued;
    #Err : Types.LeaveError;
  } {
    let t = switch (Map.get(tables, Nat.compare, tableId)) {
      case (?t) { t };
      case null { return #Err(#NotSeated) };
    };
    let seatIndex = switch (findSeat(t, caller)) {
      case (?i) { i };
      case null { return #Err(#NotSeated) };
    };
    let seat = t.seats[seatIndex];
    if (seat.inHand and not seat.hasFolded) {
      // Can't safely vacate a seat still contesting the pot -- queue it
      // instead of hard-erroring. Deliberately does NOT touch sittingOut:
      // that flag also gates nextOccupiedFrom's turn rotation (activeOnly),
      // so setting it here would skip this seat's turn entirely and the
      // setActing auto-fold hook below would never get a chance to fire.
      // The seat is instead kept off the *next* deal by actually being
      // vacated (see finalizeQueuedLeaves) before that next deal happens.
      Map.add(pendingLeaves, Text.compare, leaveKey(tableId, caller), true);
      return #Queued;
    };
    await* doLeave(t, seatIndex, caller);
  };

  public shared ({ caller }) func cancelLeaveRequest(tableId : Nat) : async { #Ok; #Err : Types.LeaveError } {
    let t = switch (Map.get(tables, Nat.compare, tableId)) {
      case (?t) { t };
      case null { return #Err(#NotSeated) };
    };
    switch (findSeat(t, caller)) {
      case (?_) {};
      case null { return #Err(#NotSeated) };
    };
    Map.remove(pendingLeaves, Text.compare, leaveKey(tableId, caller));
    #Ok;
  };

  func doLeave(t : Types.Table, seatIndex : Nat, caller : Principal) : async* {
    #Ok : Nat;
    #Queued;
    #Err : Types.LeaveError;
  } {
    let seat = t.seats[seatIndex];
    if (t.buyIn == 0) {
      // Play-money table -- nothing real to cash out; leaving and
      // rejoining is the designed way to reset to a fresh FREE_CHIPS stack.
      seat.occupant := null;
      seat.stack := 0;
      seat.sittingOut := false;
      resetAfkTimeouts(t.id, seatIndex);
      resetSittingOutSince(t.id, seatIndex);
      return #Ok(0);
    };

    if (isPendingFundsLocked(caller)) { return #Err(#TransferFailed) };
    setPendingFunds(caller);

    let amount = seat.stack;
    seat.occupant := null;
    seat.stack := 0;
    seat.sittingOut := false;
    resetAfkTimeouts(t.id, seatIndex);
    resetSittingOutSince(t.id, seatIndex);

    let Ledger = ledger();
    let fee = try { await Ledger.icrc1_fee() } catch (_e) { 10_000 };
    let payout = if (amount > fee) { amount - fee } else { 0 };
    if (payout > 0) {
      await refundOrQueue(caller, payout);
    };
    clearPendingFunds(caller);
    #Ok(payout);
  };

  // Runs at the natural end of a hand (see tick()'s Showdown reset) --
  // finalizes any leave requests queued mid-hand: actually vacates the
  // seat and cashes out, now that it's safe to do so.
  func finalizeQueuedLeaves(t : Types.Table) : async* () {
    var i = 0;
    while (i < t.seats.size()) {
      switch (t.seats[i].occupant) {
        case (?p) {
          let key = leaveKey(t.id, p);
          if (Map.get(pendingLeaves, Text.compare, key) != null) {
            Map.remove(pendingLeaves, Text.compare, key);
            ignore (await* doLeave(t, i, p));
          };
        };
        case null {};
      };
      i += 1;
    };
  };

  public shared ({ caller }) func topUpStack(tableId : Nat, amount : Nat) : async {
    #Ok : ();
    #Err : Types.JoinError;
  } {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };
    let t = switch (Map.get(tables, Nat.compare, tableId)) {
      case (?t) { t };
      case null { return #Err(#TableNotFound) };
    };
    if (t.buyIn == 0) { return #Err(#WrongBuyInAmount) }; // play-money table -- leave and rejoin for a fresh stack instead
    let seatIndex = switch (findSeat(t, caller)) {
      case (?i) { i };
      case null { return #Err(#SeatOutOfRange) };
    };
    if (t.phase != #WaitingForPlayers) { return #Err(#WrongBuyInAmount) };
    if (isPendingFundsLocked(caller)) {
      return #Err(#TransferFailed(#TemporarilyUnavailable));
    };
    setPendingFunds(caller);
    let Ledger = ledger();
    let result = try {
      await Ledger.icrc2_transfer_from({
        spender_subaccount = null;
        from = { owner = caller; subaccount = null };
        to = { owner = Principal.fromActor(self); subaccount = null };
        amount;
        fee = null;
        memo = null;
        created_at_time = null;
      });
    } catch (_e) { #Err(#TemporarilyUnavailable) };
    clearPendingFunds(caller);
    switch (result) {
      case (#Ok(_)) { t.seats[seatIndex].stack += amount; #Ok(()) };
      case (#Err(e)) { #Err(#TransferFailed(e)) };
    };
  };

  // 2026-09-10: controller-only diagnostic, added after a real incident --
  // a player's leave-payout icrc1_transfer failed (most likely a transient
  // cycles shortage during that day's several top-up incidents) and sat in
  // `pendingPayouts` until they self-served it via `claimPendingPayout`.
  // That flow already worked correctly (it's the intended safety net, not
  // a bug), but there was no way to directly check whether any OTHER
  // principal has funds stuck the same way without asking every player --
  // this makes that checkable on demand instead of guessing.
  public query ({ caller }) func adminGetPendingPayouts() : async [(Principal, Nat)] {
    requireController(caller);
    Iter.toArray(Map.entries(pendingPayouts));
  };

  public shared ({ caller }) func claimPendingPayout() : async Types.TransferResult {
    let owed = switch (Map.get(pendingPayouts, Principal.compare, caller)) {
      case (?n) { n };
      case null { return #Err(#InsufficientFunds({ balance = 0 })) };
    };
    Map.remove(pendingPayouts, Principal.compare, caller); // clear before await, retried on failure via a fresh entry
    let Ledger = ledger();
    let result = try {
      await Ledger.icrc1_transfer({
        from_subaccount = null;
        to = { owner = caller; subaccount = null };
        amount = owed;
        fee = null;
        memo = null;
        created_at_time = null;
      });
    } catch (_e) { #Err(#TemporarilyUnavailable) };
    switch (result) {
      case (#Ok(idx)) { #Ok(idx) };
      case (#Err(e)) {
        Map.add(pendingPayouts, Principal.compare, caller, owed);
        #Err(e);
      };
    };
  };

  // Self-service version of adminClearPendingFunds, for a player who hits
  // the pendingFundsActions lock (see isPendingFundsLocked above) and can't
  // reach an admin to clear it by hand -- e.g. on a phone, away from a
  // terminal. Safe by construction: it can only ever clear an entry that
  // isPendingFundsLocked ALREADY treats as expired (same
  // PENDING_FUNDS_TIMEOUT_NANOS check, same clock), so it can never race a
  // genuinely still-in-flight join/leave/topUp for this caller -- it's not
  // a way to jump the timeout early, just a way to not have to wait for a
  // retry to notice the lock already lapsed. Returns true if something was
  // actually stuck-and-cleared, false if there was nothing to clear
  // (already clear, or the lock is real and hasn't lapsed yet).
  public shared ({ caller }) func clearMyStuckPendingFunds() : async Bool {
    if (Principal.isAnonymous(caller)) { return false };
    switch (Map.get(pendingFundsSince, Principal.compare, caller)) {
      case null { false };
      case (?since) {
        if (Time.now() - since >= PENDING_FUNDS_TIMEOUT_NANOS) {
          clearPendingFunds(caller);
          true;
        } else {
          false;
        };
      };
    };
  };

  public shared ({ caller }) func sitOut(tableId : Nat, sittingOut : Bool) : async { #Ok; #Err : Types.ActionError } {
    let t = switch (Map.get(tables, Nat.compare, tableId)) { case (?t) { t }; case null { return #Err(#NotSeated) } };
    let seatIndex = switch (findSeat(t, caller)) { case (?i) { i }; case null { return #Err(#NotSeated) } };
    t.seats[seatIndex].sittingOut := sittingOut;
    if (sittingOut) {
      Map.add(sittingOutSince, Text.compare, afkKey(tableId, seatIndex), Time.now());
    } else {
      Map.remove(sittingOutSince, Text.compare, afkKey(tableId, seatIndex));
    };
    // Sitting back in can be exactly what brings a WaitingForPlayers table
    // back up to 2 active seats -- try dealing right away rather than
    // waiting on the timer (see maybeDealNow's own comment). The
    // sittingOut flag above is already committed by this point, so
    // nothing about triggerDeal's own outcome should ever turn an
    // otherwise-successful sit-back-in into a client-visible error --
    // `nudgeDeal` (see its own comment) also means a hung self-call here
    // can't block this function's own return the way a direct `await`
    // could.
    if (not sittingOut) { ignore nudgeDeal(tableId) };
    #Ok;
  };

  // ---- Hand lifecycle ----

  func seatedActiveIndices(t : Types.Table) : [Nat] {
    var buf : [Nat] = [];
    var i = 0;
    while (i < t.seats.size()) {
      let s = t.seats[i];
      if (s.occupant != null and not s.sittingOut) { buf := Array.concat<Nat>(buf, [i]) };
      i += 1;
    };
    buf;
  };

  func nextOccupiedFrom(t : Types.Table, from : Nat, activeOnly : Bool) : ?Nat {
    var i = 0;
    var idx = (from + 1) % t.seats.size();
    while (i < t.seats.size()) {
      let s = t.seats[idx];
      // Deliberately checks `inHand`, not `sittingOut`, for whether this
      // seat should get a turn: `inHand` is fixed for the whole hand at
      // deal time (already reflects sittingOut as of that moment), while
      // `sittingOut` can be toggled by the player mid-hand (see sitOut())
      // -- gating turn rotation on the live sittingOut value meant a
      // player who sat out mid-hand permanently lost its own turn for the
      // rest of that hand (found 2026-09-05, same underlying mistake as
      // the leave-queue bug above, just via a different caller).
      let ok = s.occupant != null and (not activeOnly or (s.inHand and not s.hasFolded and not s.isAllIn));
      if (ok) { return ?idx };
      idx := (idx + 1) % t.seats.size();
      i += 1;
    };
    null;
  };

  func liveSeats(t : Types.Table) : [Nat] {
    // Dealt into the current hand and not folded (may be all-in).
    Array.filter<Nat>(
      Array.tabulate<Nat>(t.seats.size(), func(i) { i }),
      func(i) { t.seats[i].inHand and not t.seats[i].hasFolded },
    );
  };

  // 2026-09-10: hardened after a real recurring incident -- the tick()
  // timer keeps dying completely (freezing every table, confirmed twice
  // live on mainnet the same day via getTickDiagnostics, even after
  // wrapping the timer's own `await* tick()` in try/catch) with no
  // "tick(): trapped" log ever appearing, meaning it's very likely an
  // uncatchable runtime trap somewhere in tick()'s synchronous code, not
  // a catchable Error -- Motoko's try/catch only catches Error values
  // from a failed await, never a genuine trap (array-index-out-of-bounds,
  // Nat underflow, etc.), which happens in code executed directly inside
  // a Timer callback with no caller to see a reject message either, so
  // it's very hard to pin down from the outside. `t.deck[0]` here is the
  // single most plausible uncatchable-trap candidate found by inspection
  // (an out-of-bounds index if the deck were ever empty) even though the
  // normal draw count per hand (<=21 for 8 seats) is nowhere near 52 --
  // guarding it directly removes this specific trap class regardless of
  // whether it's actually the culprit, and logs loudly if it ever fires
  // so this is provable next time rather than still-guessed. Returning 0
  // ("2 of suit 0") on empty is a deliberately bad fallback for an
  // already-impossible state -- better than permanently freezing the
  // timer for every table, never meant to be reached in practice.
  func drawCard(t : Types.Table) : Nat8 {
    if (t.deck.size() == 0) {
      Debug.print("drawCard: deck empty, table=" # debug_show (t.id) # " phase=" # debug_show (t.phase) # " handNumber=" # debug_show (t.handNumber));
      return 0;
    };
    let c = t.deck[0];
    t.deck := Array.sliceToArray<Nat8>(t.deck, 1, t.deck.size());
    c;
  };

  // Starts a new hand: rotates the button, posts blinds, shuffles with
  // fresh raw_rand entropy, deals hole cards. The only place this
  // canister draws randomness -- everything after (streets, showdown) is
  // just revealing the rest of the already-shuffled deck, no further
  // randomness needed, so no further async is needed there either.
  func dealNextHand(t : Types.Table) : async* () {
    let active = seatedActiveIndices(t);
    if (active.size() < 2) {
      // Quiet for genuinely-empty tables (0 occupants -- the overwhelming
      // majority of tick() calls into this function) but logged when a
      // table has real occupants and still isn't dealing: 2026-09-09
      // instrumentation for a recurring "never deals via the timer, works
      // instantly via adminForceDealNextHand" mainnet incident -- neither
      // this guard nor the later liveSeats one (also logged) had fired in
      // prior occurrences, which was itself the confusing part.
      let occupied = Array.filter<Types.Seat>(t.seats, func(s) { s.occupant != null });
      if (occupied.size() > 0) {
        Debug.print(
          "dealNextHand: top guard, active<2, table=" # debug_show (t.id) #
          " active=" # debug_show (active) # " seats=" # debug_show (
            Array.map<Types.Seat, (Bool, Bool, Bool, Nat)>(
              t.seats,
              func(s) { (s.occupant != null, s.sittingOut, s.inHand, s.stack) },
            )
          )
        );
      };
      return;
    };
    if (t.phase != #WaitingForPlayers) { return };

    // See dealingTables' own comment: only one attempt to deal this table
    // may be in flight at a time, no matter which of the several trigger
    // sources called this. Acquired here (after the cheap synchronous
    // guards above, right before the only await) and released on every
    // exit path below.
    if (Map.get(dealingTables, Nat.compare, t.id) == ?true) { return };
    Map.add(dealingTables, Nat.compare, t.id, true);

    // Fetch entropy BEFORE mutating any seat/table state -- this is the
    // only await in this function, and a canister message can be
    // interleaved with other calls (or the tick timer's next firing) while
    // it's outstanding. Used to reset inHand/handNumber/board first and
    // bail out on failure: if raw_rand ever traps or is rejected (rare, but
    // seen for real under a cycles crunch -- see PikoPoker's own incident
    // notes), that left every seat stuck at inHand=true forever with a
    // stale lastResult and a bumped handNumber but no hand actually dealt,
    // since nothing ever reset those fields afterward (dealNextHand's own
    // <2-active guard above keeps re-triggering the same early return, and
    // the Showdown-only cleanup in tick() never runs because phase never
    // left WaitingForPlayers). Symptom: leaveTable stuck queuing forever
    // ("Leaving after this hand...") since it trusts seat.inHand.
    let Management : Types.ManagementActor = actor ("aaaaa-aa");
    let entropy = try { await Management.raw_rand() } catch (e) {
      // Couldn't get randomness -- stay in WaitingForPlayers and try again
      // on the next timer tick rather than dealing with a weak fallback.
      // 2026-09-09: logged -- this is the last un-instrumented silent-skip
      // site in this function (the two guards after this point already
      // log), and this morning's own comment already suspected raw_rand
      // specifically failing when called from a Timer-invoked closure on
      // mainnet (vs succeeding every time as a plain update call, which is
      // all adminForceDealNextHand ever does) without ever having proven
      // it.
      Debug.print("dealNextHand: raw_rand failed, table=" # debug_show (t.id) # " error=" # Error.message(e));
      Map.remove(dealingTables, Nat.compare, t.id);
      return;
    };

    // Re-check phase after the only await in this function -- if another
    // concurrent dealNextHand call for this same table (e.g. from an
    // orphaned duplicate timer, see startTicker's own comment) already won
    // the race and dealt a hand while this call's raw_rand was in flight,
    // t.phase is no longer WaitingForPlayers and mutating again here would
    // stomp an already-live hand (re-shuffle its deck, re-post blinds,
    // reset its board). Nothing below this point ever awaits again, so
    // whichever call resumes first and passes this check runs to
    // completion atomically before any other call's continuation can run.
    if (t.phase != #WaitingForPlayers) {
      Debug.print("dealNextHand: phase changed during raw_rand await, table=" # debug_show (t.id) # " phase=" # debug_show (t.phase));
      Map.remove(dealingTables, Nat.compare, t.id);
      return;
    };

    for (s in t.seats.vals()) {
      s.holeCards := null;
      s.committedThisRound := 0;
      s.committedThisHand := 0;
      s.hasFolded := false;
      s.isAllIn := false;
      s.inHand := (s.occupant != null and not s.sittingOut and s.stack > 0);
    };
    t.board := [];
    t.handNumber += 1;

    let deck = VarArray.fromArray<Nat8>(Cards.freshDeck());
    Cards.shuffle(deck, Cards.entropyToNat(Blob.toArray(entropy)));
    t.deck := VarArray.toArray<Nat8>(deck);

    // Button rotates to the next occupied seat (active or not -- someone
    // sitting out still holds their spot in the rotation).
    t.dealerSeat := switch (nextOccupiedFrom(t, t.dealerSeat, false)) {
      case (?s) { s };
      case null { t.dealerSeat };
    };

    let liveNow = liveSeats(t);
    if (liveNow.size() < 2) {
      // Shouldn't normally happen -- the top-of-function guard already
      // required 2+ seatedActiveIndices (occupant set, not sittingOut,
      // stack NOT checked there) before the only await in this function.
      // This second, stricter liveSeats gate (inHand, which DOES require
      // stack > 0) is checked after that await -- so this only fires if a
      // seat's stack/sittingOut genuinely changed during the raw_rand
      // round-trip (a real concurrent update call landing mid-await) or
      // some other seat-state edge case. Logged (2026-09-09) specifically
      // to catch a recurring "never deals via the timer, works instantly
      // via adminForceDealNextHand" mainnet incident whose root cause
      // wasn't otherwise provable -- see `icp canister logs` if this ever
      // fires again.
      Debug.print(
        "dealNextHand: aborting to WaitingForPlayers, table=" # debug_show (t.id) #
        " handNumber=" # debug_show (t.handNumber) # " liveNow=" # debug_show (liveNow) #
        " seats=" # debug_show (
          Array.map<Types.Seat, (Bool, Bool, Bool, Nat)>(
            t.seats,
            func(s) { (s.occupant != null, s.sittingOut, s.inHand, s.stack) },
          )
        )
      );
      // 2026-09-10: real bug, found live from real money stuck on a Micro
      // table -- this abort left `inHand` at whatever the optimistic loop
      // above just set it to (true, for every seat that looked qualified
      // by the top-of-function guard) without ever undoing it, since only
      // this second, stricter check caught the problem. A solo remaining
      // player was then stuck with inHand=true forever despite genuinely
      // sitting in WaitingForPlayers with no hand in progress -- which
      // made leaveTable wrongly think they were still contesting a live
      // pot and QUEUE their leave (see leaveTable's own inHand check)
      // instead of paying them out immediately. Nothing ever un-queues it
      // for a solo table (finalizeQueuedLeaves only runs on a genuine
      // Showdown->WaitingForPlayers transition, which can't happen again
      // with fewer than 2 players), so the real PIKO buy-in sat stuck in
      // escrow indefinitely. Reset back to a genuinely clean
      // WaitingForPlayers here, not just the phase flag.
      for (s in t.seats.vals()) { s.inHand := false };
      t.phase := #WaitingForPlayers;
      Map.remove(dealingTables, Nat.compare, t.id);
      return;
    };

    // Heads-up (2 players): dealer posts small blind, same convention as
    // real rooms. 3+: small blind is the seat after the dealer.
    let sbSeat = if (liveNow.size() == 2) { t.dealerSeat } else {
      switch (nextOccupiedFrom(t, t.dealerSeat, true)) { case (?s) { s }; case null { t.dealerSeat } };
    };
    let bbSeat = switch (nextOccupiedFrom(t, sbSeat, true)) { case (?s) { s }; case null { sbSeat } };

    postBlind(t, sbSeat, t.smallBlind);
    postBlind(t, bbSeat, t.bigBlind);
    t.currentBet := t.bigBlind;
    t.minRaiseAmount := t.bigBlind;

    // Deal two hole cards to each live seat, one card at a time around the
    // table, dealer-to-act order -- purely cosmetic ordering (all cards
    // already fixed by the shuffle), matches how a real dealer would go.
    var round = 0;
    while (round < 2) {
      for (i in liveNow.vals()) {
        let s = t.seats[i];
        s.holeCards := switch (s.holeCards) {
          case null { ?(drawCard(t), 0 : Nat8) };
          case (?(a, _)) { ?(a, drawCard(t)) };
        };
      };
      round += 1;
    };

    t.phase := #PreFlop;
    // Defensive, not load-bearing -- revealCards already requires phase
    // == #Showdown too, so a stale realShowdownTables entry couldn't leak
    // anything during PreFlop/Flop/Turn/River regardless. Cleared here
    // anyway, same "explicit over merely implicit" spirit as
    // endHandByFold's own remove.
    Map.remove(realShowdownTables, Nat.compare, t.id);
    t.toAct := liveNow.size();
    let firstToAct = switch (nextOccupiedFrom(t, bbSeat, true)) { case (?s) { s }; case null { bbSeat } };
    setActing(t, ?firstToAct);
    Map.remove(dealingTables, Nat.compare, t.id);
  };

  // Attempts to deal a table that's WaitingForPlayers and past its pause,
  // same check tick() has always done -- pulled out so player-initiated
  // update calls (join, sitting back in) can also trigger it directly, not
  // just the timer. 2026-09-09: root-caused (see startTicker's own comment
  // below) that `Management.raw_rand()` reliably fails specifically when
  // called from inside a Timer-invoked closure on mainnet ("could not
  // perform remote call"), while succeeding every time as a plain
  // caller-initiated update call -- exactly what this is. A new seat
  // filling a table (the most common way a game is expected to "just
  // start") no longer has to wait on the flaky timer path at all.
  func maybeDealNow(t : Types.Table) : async* () {
    if (t.phase != #WaitingForPlayers) { return };
    let ready = switch (t.nextHandAt) {
      case (?at) { Time.now() >= at };
      case null { true };
    };
    if (ready) {
      t.nextHandAt := null;
      await* dealNextHand(t);
    };
  };

  // See soloIdleSince's own comment above for the bug this fixes. Shares
  // the same "callable from tick() AND triggerDeal" shape as
  // maybeDealNow/maybeCleanupShowdown/maybeEnforceActionTimeout, for the
  // same reason: any seated client's own periodic nudge (not just the
  // sometimes-flaky backend timer) should be able to resolve this.
  func maybeCleanupIdleSeats(t : Types.Table) : async* () {
    if (t.phase != #WaitingForPlayers) { return };
    var occupied : [Nat] = [];
    var i = 0;
    while (i < t.seats.size()) {
      if (t.seats[i].occupant != null) { occupied := Array.concat<Nat>(occupied, [i]) };
      i += 1;
    };
    if (occupied.size() == 0 or seatedActiveIndices(t).size() >= 2) {
      Map.remove(soloIdleSince, Nat.compare, t.id);
      return;
    };
    switch (Map.get(soloIdleSince, Nat.compare, t.id)) {
      case null { Map.add(soloIdleSince, Nat.compare, t.id, Time.now()) };
      case (?since) {
        if (Time.now() - since >= SOLO_IDLE_TIMEOUT_NANOS) {
          for (seatIndex in occupied.vals()) {
            switch (t.seats[seatIndex].occupant) {
              case (?p) { ignore (await* doLeave(t, seatIndex, p)) };
              case null {};
            };
          };
          Map.remove(soloIdleSince, Nat.compare, t.id);
        };
      };
    };
  };

  // 2026-09-16: per-seat counterpart to maybeCleanupIdleSeats above -- see
  // SIT_OUT_TIMEOUT_NANOS/sittingOutSince's own comments for the gap this
  // closes (a sittingOut seat sitting next to 2+ other active seats never
  // trips the table-level check above). Deliberately NOT gated on
  // `t.phase == #WaitingForPlayers` -- unlike maybeCleanupIdleSeats, this
  // has to keep working while OTHER seats are mid-hand in any phase, since
  // that's exactly the scenario it exists for. Per-seat safety instead:
  // only ever vacates a seat that is sittingOut AND not inHand, which is
  // exactly the same invariant leaveTable's own immediate-vs-#Queued check
  // already relies on -- a seat that's sittingOut but still inHand (a
  // mid-hand toggle) is left alone here and picked up naturally once that
  // hand ends (inHand goes false at the next deal or a real fold/leave).
  func maybeCleanupSittingOutSeats(t : Types.Table) : async* () {
    var i = 0;
    while (i < t.seats.size()) {
      let s = t.seats[i];
      let key = afkKey(t.id, i);
      if (s.occupant != null and s.sittingOut and not s.inHand) {
        switch (Map.get(sittingOutSince, Text.compare, key)) {
          case null { Map.add(sittingOutSince, Text.compare, key, Time.now()) };
          case (?since) {
            if (Time.now() - since >= SIT_OUT_TIMEOUT_NANOS) {
              switch (s.occupant) {
                case (?p) { ignore (await* doLeave(t, i, p)) };
                case null {};
              };
              Map.remove(sittingOutSince, Text.compare, key);
            };
          };
        };
      } else {
        Map.remove(sittingOutSince, Text.compare, key);
      };
      i += 1;
    };
  };

  // 2026-09-10: extracted from tick()'s own #Showdown case (still used
  // from there too) so `triggerDeal` below can also perform this cleanup
  // directly, not just the backend timer. Real incident: the timer
  // freezing (see drawCard's own comment on the still-not-fully-
  // root-caused cause) left a table stuck showing "Showdown complete"
  // forever with no recovery path at all -- the frontend's periodic
  // `triggerDeal` nudge only fires while `phase == WaitingForPlayers`
  // (this cleanup is exactly what's needed to ever REACH that phase from
  // Showdown), so a frozen timer during Showdown had genuinely no way
  // back, timer bug or not. Reusing the proven-reliable "ordinary
  // client-initiated update call" path here means a frozen timer no
  // longer permanently strands a table -- it becomes at most a few
  // seconds' delay until some seated client's next nudge lands, same
  // safety margin as the existing WaitingForPlayers->dealt nudge.
  func maybeCleanupShowdown(t : Types.Table) : async* () {
    if (t.phase != #Showdown) { return };
    let at = switch (t.nextHandAt) { case (?at) { at }; case null { return } };
    if (Time.now() < at) { return };
    var i = 0;
    while (i < t.seats.size()) {
      let s = t.seats[i];
      s.inHand := false;
      s.hasFolded := false;
      s.isAllIn := false;
      s.committedThisHand := 0;
      s.committedThisRound := 0;
      if (s.stack == 0 and s.occupant != null) {
        s.sittingOut := true;
        Map.add(sittingOutSince, Text.compare, afkKey(t.id, i), Time.now());
      };
      i += 1;
    };
    t.board := [];
    t.lastResult := null;
    t.phase := #WaitingForPlayers;
    t.nextHandAt := null;
    await* finalizeQueuedLeaves(t);
  };

  // 2026-09-11: extracted from tick()'s own action-timeout case (still
  // used from there too), same reasoning as maybeCleanupShowdown above --
  // the dev reported live that an AFK player's clock hitting 0 did
  // nothing. Root cause: this enforcement has only ever run from the
  // backend timer, and the timer is the same one that keeps dying for
  // reasons still not fully root-caused (see drawCard's own comment) --
  // when it's dead, action-timeout enforcement silently stops right
  // alongside dealing and Showdown cleanup, but unlike those two, it
  // never got its own client-callable fallback. Fixed the same way:
  // `triggerDeal` (below) now also calls this, so any OTHER seated
  // client still watching the table (the AFK player's own client
  // obviously isn't polling) can resolve the timeout on their behalf.
  //
  // Also implements the dev's second ask here: 4 consecutive turns
  // resolved by this timeout (not a real action -- see afkTimeouts' own
  // comment in types.mo) force-vacates the seat, so an AFK player can't
  // sit occupying a seat indefinitely (their own framing: "pour eviter
  // qu'un joueur afk bloque une table publique"). Auto-FOLD (already
  // not live in the current hand) is safe to vacate immediately, same
  // guarantee leaveTable's own hasFolded check already relies on for a
  // self-requested leave. Auto-CHECK (still live -- didn't owe anything
  // this street) is NOT safe to vacate immediately (would silently
  // delete a still-live contestant's claim on the pot, along with their
  // stack, if they were to end up winning it) -- queued via the exact
  // same `pendingLeaves` mechanism a normal mid-hand leave request uses,
  // so it resolves safely once the hand naturally ends.
  func maybeEnforceActionTimeout(t : Types.Table) : async* () {
    switch (t.phase) {
      case (#WaitingForPlayers or #Showdown) { return };
      case (_) {};
    };
    let deadline = switch (t.actionDeadline) { case (?d) { d }; case null { return } };
    if (Time.now() < deadline) { return };
    let seatIndex = switch (t.actingSeat) { case (?i) { i }; case null { return } };
    let s = t.seats[seatIndex];
    // Auto-check if free, else auto-fold -- never auto-bets.
    let folded = t.currentBet > s.committedThisRound;
    if (folded) { s.hasFolded := true };
    advanceAfterAction(t, seatIndex);
    let count = getAfkTimeouts(t.id, seatIndex) + 1;
    if (count >= 4) {
      switch (s.occupant) {
        case (?p) {
          // doLeave/the queue both already clear this on the way out
          // (see their own resetAfkTimeouts calls) -- no need to persist
          // `count` here first.
          if (folded) {
            ignore (await* doLeave(t, seatIndex, p));
          } else {
            Map.add(pendingLeaves, Text.compare, leaveKey(t.id, p), true);
          };
        };
        case null {};
      };
    } else {
      Map.add(afkTimeouts, Text.compare, afkKey(t.id, seatIndex), count);
    };
  };

  // 2026-09-09: every caller below routes THROUGH this public method (a
  // genuine self-call via `self.triggerDeal(...)`, a real inter-canister
  // round trip) instead of calling `maybeDealNow`/`dealNextHand` directly
  // as a local function. Empirically, only that exact shape --
  // `adminForceDealNextHand`, called fresh from outside -- ever succeeded
  // reliably at the `raw_rand` call inside; every local-function-call path
  // (from tick(), and even from a plain player-triggered sitOut once it
  // called `maybeDealNow` as a local function) consistently failed with
  // "could not perform remote call", logged directly, not guessed. The
  // exact IC/Motoko mechanism behind that difference isn't confirmed, but
  // the empirical pattern was consistent enough across many attempts to
  // build the real fix around it rather than keep guessing blind. No
  // permission gate (unlike adminForceDealNextHand) -- safe for anyone to
  // call, since dealNextHand's own guards make it a no-op unless the table
  // genuinely needs dealing.
  //
  // 2026-09-10: also runs the Showdown->WaitingForPlayers cleanup first
  // (see maybeCleanupShowdown's own comment) -- a table stuck at
  // "Showdown complete" only has a path back to WaitingForPlayers via
  // that cleanup, and the frontend's periodic nudge only fires once
  // phase IS WaitingForPlayers, so without this, a frozen backend timer
  // during Showdown had no recovery route at all. Both steps share this
  // one client-proven-reliable call.
  // 2026-09-15: real vulnerability, found in a full security audit --
  // this has no caller check (by design, see the comment above) AND no
  // rate limit at all, so anyone could call it in a tight loop, for
  // free, forcing this canister to keep paying real cycles for the full
  // per-table sweep every single time -- a ready-made amplifier for the
  // exact cycles-exhaustion incidents this whole file already has a long
  // history of. Throttled to at most once per table per second --
  // TRIGGER_DEAL_MIN_INTERVAL_NANOS matches the backend timer's own
  // TICK_INTERVAL_SECONDS cadence, so every LEGITIMATE caller (the
  // timer itself, every seated client's ~3s per-table nudge, a fresh
  // join's own nudgeDeal) is already calling slower than this and is
  // never throttled -- only calls faster than any real usage pattern
  // would ever produce get skipped. A throttled call skipping this
  // table's sweep for up to ~1s is exactly the same "another nudge
  // catches it shortly after" tolerance this file already relies on
  // everywhere else (nudgeDeal, the global tickWork() nudge, etc.), not
  // a new risk.
  let lastTriggerDealAt : Map.Map<Nat, Int> = Map.empty<Nat, Int>();
  let TRIGGER_DEAL_MIN_INTERVAL_NANOS : Int = 1 * 1_000_000_000;

  public shared func triggerDeal(tableId : Nat) : async () {
    switch (Map.get(lastTriggerDealAt, Nat.compare, tableId)) {
      case (?at) { if (Time.now() - at < TRIGGER_DEAL_MIN_INTERVAL_NANOS) { return } };
      case null {};
    };
    Map.add(lastTriggerDealAt, Nat.compare, tableId, Time.now());
    switch (Map.get(tables, Nat.compare, tableId)) {
      case (?t) {
        await* maybeCleanupShowdown(t);
        await* maybeDealNow(t);
        await* maybeCleanupIdleSeats(t);
        await* maybeCleanupSittingOutSeats(t);
        await* maybeEnforceActionTimeout(t);
      };
      case null {};
    };
  };

  // 2026-09-12: real bug, reported live -- the dev rejoined a table with
  // an account that had just left, and the hand never dealt. Root cause,
  // by the same evidence pattern as this session's `tickWork()` self-call
  // investigation: `joinPublicTable`/`joinPrivateTable`/`sitOut` all
  // directly `await self.triggerDeal(...)` -- and if that self-call ever
  // HANGS (sent, never resolving -- not rejecting, which the existing
  // try/catch already handled fine) rather than trapping or rejecting,
  // the ENTIRE outer call hangs right along with it, forever. For the two
  // join methods this is worse than just "the deal didn't happen": the
  // `Map.remove(pendingFundsActions, ...)` cleanup sits AFTER this call
  // in the same function, so a hang here means it's never reached either
  // -- permanently locking that principal out of joining ANY table again
  // (every future join immediately hits the pendingFundsActions guard).
  // This is the exact same failure SHAPE as the 2026-09-10 entry right
  // above it (an uncaught reject skipping the same cleanup) -- just the
  // hang variant of it, which try/catch cannot help with at all.
  //
  // Fixed the same way as the timer's own self-call: fire it via an
  // un-awaited `async {}` block instead of a direct `await`. The call is
  // still genuinely sent immediately (Motoko dispatches on the call
  // expression, not on `await`), so this is no less "real" a nudge than
  // before -- but the CALLER (join/sitOut) can no longer be blocked by
  // whatever happens to it, and reaches its own cleanup/return
  // immediately regardless. Combined with the frontend's own periodic
  // external nudges (per-table triggerDeal every 3s, and a global
  // tickWork() every 5s, neither of which depend on this self-call
  // either), a hang here now has no way to block real gameplay at all.
  func nudgeDeal(tableId : Nat) : async () {
    try {
      await self.triggerDeal(tableId);
    } catch (e) {
      Debug.print("nudgeDeal: triggerDeal self-call failed -- " # Error.message(e));
    };
  };

  func postBlind(t : Types.Table, seatIndex : Nat, amount : Nat) {
    let s = t.seats[seatIndex];
    let posted = if (amount >= s.stack) { s.isAllIn := true; s.stack } else { amount };
    s.stack -= posted;
    s.committedThisRound += posted;
    s.committedThisHand += posted;
  };

  func setActing(t : Types.Table, seatIndex : ?Nat) {
    switch (seatIndex) {
      case (?i) {
        switch (t.seats[i].occupant) {
          case (?p) {
            if (Map.get(pendingLeaves, Text.compare, leaveKey(t.id, p)) != null) {
              // Asked to leave mid-hand -- don't make it sit through a
              // full turn just to fold; auto-fold the instant it's its
              // turn, same as tick()'s AFK-timeout path below.
              t.seats[i].hasFolded := true;
              t.actingSeat := null;
              t.actionDeadline := null;
              advanceAfterAction(t, i);
              return;
            };
          };
          case null {};
        };
      };
      case null {};
    };
    t.actingSeat := seatIndex;
    t.actionDeadline := switch (seatIndex) {
      case (?_) { ?(Time.now() + ACTION_TIMEOUT_NANOS) };
      case null { null };
    };
  };

  // ---- Betting actions (all synchronous -- funds already escrowed, no
  // ledger call needed until leaveTable, so Motoko's message-atomicity
  // already rules out any interleaving between two players' actions) ----

  func requireTurn(t : Types.Table, caller : Principal) : ?Nat {
    let seatIndex = switch (t.actingSeat) { case (?i) { i }; case null { return null } };
    if (t.seats[seatIndex].occupant != ?caller) { return null };
    ?seatIndex;
  };

  public shared ({ caller }) func fold(tableId : Nat) : async { #Ok; #Err : Types.ActionError } {
    let t = switch (Map.get(tables, Nat.compare, tableId)) { case (?t) { t }; case null { return #Err(#NoHandInProgress) } };
    let seatIndex = switch (requireTurn(t, caller)) { case (?i) { i }; case null { return #Err(#NotYourTurn) } };
    // A real action from the occupant themselves -- see afkTimeouts' own
    // comment on why this resets (but the timeout-driven path that also
    // calls hasFolded:=true, in maybeEnforceActionTimeout, must NOT).
    resetAfkTimeouts(tableId, seatIndex);
    t.seats[seatIndex].hasFolded := true;
    advanceAfterAction(t, seatIndex);
    #Ok;
  };

  public shared ({ caller }) func checkOrCall(tableId : Nat) : async { #Ok; #Err : Types.ActionError } {
    let t = switch (Map.get(tables, Nat.compare, tableId)) { case (?t) { t }; case null { return #Err(#NoHandInProgress) } };
    let seatIndex = switch (requireTurn(t, caller)) { case (?i) { i }; case null { return #Err(#NotYourTurn) } };
    let s = t.seats[seatIndex];
    resetAfkTimeouts(tableId, seatIndex);
    let owe = if (t.currentBet > s.committedThisRound) { t.currentBet - s.committedThisRound } else { 0 };
    let paid = if (owe >= s.stack) { s.isAllIn := true; s.stack } else { owe };
    s.stack -= paid;
    s.committedThisRound += paid;
    s.committedThisHand += paid;
    advanceAfterAction(t, seatIndex);
    #Ok;
  };

  public shared ({ caller }) func betOrRaiseTo(tableId : Nat, toAmount : Nat) : async {
    #Ok;
    #Err : Types.ActionError;
  } {
    let t = switch (Map.get(tables, Nat.compare, tableId)) { case (?t) { t }; case null { return #Err(#NoHandInProgress) } };
    let seatIndex = switch (requireTurn(t, caller)) { case (?i) { i }; case null { return #Err(#NotYourTurn) } };
    let s = t.seats[seatIndex];
    // Reset as soon as a real attempt from the seat's own occupant is
    // confirmed (requireTurn passed) -- even an invalid amount below is
    // still evidence they're present and acting, not AFK.
    resetAfkTimeouts(tableId, seatIndex);
    if (toAmount <= t.currentBet) { return #Err(#IllegalAction("must raise above the current bet")) };
    let need = toAmount - s.committedThisRound;
    let allIn = need >= s.stack;
    let raiseSize = toAmount - t.currentBet;
    if (not allIn and raiseSize < t.minRaiseAmount) {
      return #Err(#IllegalAction("raise is smaller than the minimum raise"));
    };
    let paid = if (allIn) { s.stack } else { need };
    s.stack -= paid;
    s.committedThisRound += paid;
    s.committedThisHand += paid;
    if (allIn) { s.isAllIn := true };
    if (s.committedThisRound > t.currentBet) {
      t.minRaiseAmount := s.committedThisRound - t.currentBet;
      t.currentBet := s.committedThisRound;
      // Action reopens for everyone else still live and not all-in --
      // `reopen` already excludes this seat (the raiser), so it's the
      // exact number of players who still need to act. Found live
      // (2026-09-10, the dev: "if the first checks and the second bets,
      // the turn passes without forcing the first to call or fold"):
      // the old code set toAct to this already-correct count and then
      // *also* decremented it once more via a shared advanceTurnOnly
      // helper, double-counting the raiser's own action and closing the
      // betting round one player too early -- e.g. heads-up, A checks
      // (toAct 2->1), B raises (reopen correctly computes 1, for A) --
      // the extra decrement took it to 0, ending the round without ever
      // giving A the chance to call/fold/re-raise B's bet.
      var reopen = 0;
      for (i in liveSeats(t).vals()) {
        if (i != seatIndex and not t.seats[i].isAllIn) { reopen += 1 };
      };
      t.toAct := reopen;
    } else if (t.toAct > 0) {
      // Only reachable if a short all-in still doesn't clear the current
      // bet (raiseSize/minRaise checks above allow that) -- didn't
      // reopen anyone else's action, so this seat's own turn is the one
      // being consumed here, same as a normal call.
      t.toAct -= 1;
    };
    finishActionAdvance(t, seatIndex);
    #Ok;
  };

  func advanceAfterAction(t : Types.Table, actedSeat : Nat) {
    if (t.toAct > 0) { t.toAct -= 1 };
    finishActionAdvance(t, actedSeat);
  };

  func finishActionAdvance(t : Types.Table, actedSeat : Nat) {
    let live = liveSeats(t);
    if (live.size() <= 1) { return endHandByFold(t) };

    // 2026-09-12: real bug, reported live by the dev as two apparently
    // separate symptoms -- "quand quelqu'un fait all-in, la partie se
    // finit automatiquement" (going all-in ends the hand automatically)
    // and "leave finit juste le tour, pas la main complete" (leaving mid-
    // hand cuts the hand short for whoever's left) -- both turned out to
    // be the exact same root cause, reproduced directly: heads-up, A
    // shoves all-in raising over B's blind. `reopen`/`toAct` correctly
    // becomes 1 (B still needs to call or fold), but the OLD `or
    // contestants <= 1` clause below ALSO independently went true at the
    // same moment (B is now the only live seat that isn't all-in) and
    // won the `or`, jumping straight to `advanceStreet` -- running out
    // the entire board and reaching Showdown with B's turn simply never
    // offered. Confirmed via a real call sequence: B's `committedThisRound`
    // stayed at their blind, `stack` completely untouched, yet the table
    // was already at `#Showdown` with a full 5-card board dealt. A queued
    // leave (which auto-folds the leaving seat the instant it's their
    // turn, going through this exact same function) hits the identical
    // trap whenever that fold happens to leave exactly one live
    // non-all-in seat that hasn't matched the current bet yet -- same
    // bug, different trigger.
    //
    // `contestants <= 1` was never actually a valid alternative signal for
    // "no more action possible THIS round" in the first place: whether
    // anyone still needs to act on the CURRENT bet is exactly what
    // `t.toAct` already tracks, precisely and only. The genuinely
    // legitimate "everyone left is all-in, run the board with no more
    // betting" case is a NEW STREET starting with zero (or one) live
    // non-all-in seats -- and that's already handled correctly and
    // separately, inside `advanceStreet` itself, BEFORE it ever sets
    // `toAct` for the new street. This function only runs after a real
    // seat's own action, mid-round, where `toAct` is always the correct
    // and only signal for whether the round is over.
    if (t.toAct == 0) {
      advanceStreet(t);
      return;
    };
    switch (nextOccupiedFrom(t, actedSeat, true)) {
      case (?nextSeat) { setActing(t, ?nextSeat) };
      case null { advanceStreet(t) };
    };
  };

  func resetRoundCommitments(t : Types.Table) {
    for (s in t.seats.vals()) { s.committedThisRound := 0 };
    t.currentBet := 0;
    t.minRaiseAmount := t.bigBlind;
  };

  func firstToActPostflop(t : Types.Table) : ?Nat {
    nextOccupiedFrom(t, t.dealerSeat, true);
  };

  func advanceStreet(t : Types.Table) {
    resetRoundCommitments(t);
    let live = liveSeats(t);
    var contestants = 0;
    for (i in live.vals()) { if (not t.seats[i].isAllIn) { contestants += 1 } };

    switch (t.phase) {
      case (#PreFlop) {
        t.board := [drawCard(t), drawCard(t), drawCard(t)];
        t.phase := #Flop;
      };
      case (#Flop) { t.board := Array.concat<Nat8>(t.board, [drawCard(t)]); t.phase := #Turn };
      case (#Turn) { t.board := Array.concat<Nat8>(t.board, [drawCard(t)]); t.phase := #River };
      case (#River) { return endHandShowdown(t) };
      case (_) { return };
    };

    if (contestants <= 1) {
      // Everyone left is all-in (or only one non-all-in with the rest
      // folded, handled above) -- run the board out with no more betting.
      setActing(t, null);
      advanceStreet(t);
      return;
    };

    t.toAct := contestants;
    setActing(t, firstToActPostflop(t));
  };

  // ---- Pots (side pots for uneven all-ins) ----

  func computePots(t : Types.Table) : [Types.Pot] {
    // Standard level algorithm: distinct nonzero contribution levels among
    // seats still holding chips in the hand (folded seats' chips still
    // count toward pot size, just not toward eligibility).
    var contributors : [Nat] = [];
    for (i in Array.tabulate<Nat>(t.seats.size(), func(i) { i }).vals()) {
      if (t.seats[i].inHand and t.seats[i].committedThisHand > 0) {
        contributors := Array.concat<Nat>(contributors, [i]);
      };
    };
    if (contributors.size() == 0) { return [] };

    var levels : [Nat] = [];
    for (i in contributors.vals()) {
      let c = t.seats[i].committedThisHand;
      if (Array.find<Nat>(levels, func(l) { l == c }) == null) {
        levels := Array.concat<Nat>(levels, [c]);
      };
    };
    levels := Array.sort<Nat>(levels, func(a, b) { if (a < b) { #less } else if (a > b) { #greater } else { #equal } });

    var pots : [Types.Pot] = [];
    var prevLevel = 0;
    for (level in levels.vals()) {
      let slice = level - prevLevel;
      var amount = 0;
      var eligible : [Nat] = [];
      for (i in contributors.vals()) {
        let c = t.seats[i].committedThisHand;
        if (c >= level) {
          amount += slice;
          if (not t.seats[i].hasFolded) { eligible := Array.concat<Nat>(eligible, [i]) };
        } else if (c > prevLevel) {
          amount += (c - prevLevel);
        };
      };
      if (amount > 0 and eligible.size() > 0) {
        pots := Array.concat<Types.Pot>(pots, [{ amount; eligibleSeats = eligible }]);
      };
      prevLevel := level;
    };
    pots;
  };

  func applyRake(t : Types.Table, potAmount : Nat) : Nat {
    // Free Play's buyIn==0 chips aren't real PIKO -- taking a cut of them
    // would just be phantom accounting mixed into the same rakeBalance
    // real-money rake uses, with no real value behind it (found 2026-09-18:
    // rakeBalance read 773 PIKO while the canister's actual PIKO ledger
    // balance was only 2.05 -- almost entirely Free Play's fake "rake").
    if (rakeBps == 0 or potAmount == 0 or t.buyIn == 0) { return potAmount };
    let cap = t.bigBlind * rakeCapBigBlinds;
    var rake = (potAmount * rakeBps) / 10_000;
    if (rake > cap) { rake := cap };
    if (rake >= potAmount) { return potAmount };
    rakeBalance += rake;
    potAmount - rake;
  };

  func endHandByFold(t : Types.Table) {
    let live = liveSeats(t);
    setActing(t, null);
    switch (live.size()) {
      case (0) {};
      case (_) {
        let winner = live[0];
        var totalPot = 0;
        for (s in t.seats.vals()) { totalPot += s.committedThisHand };
        let payout = applyRake(t, totalPot);
        t.seats[winner].stack += payout;
        t.lastResult := ?("Won uncontested"); // caller-facing name resolution happens in the frontend, which already knows the principal
      };
    };
    // Explicit remove, not just "never added" -- a table that already had
    // a real showdown earlier could theoretically still have a stale true
    // here if dealNextHand's own reset (see below) were ever skipped;
    // removing here too costs nothing and keeps this path correct on its
    // own regardless of that.
    Map.remove(realShowdownTables, Nat.compare, t.id);
    t.phase := #Showdown;
    t.nextHandAt := ?(Time.now() + HAND_PAUSE_NANOS);
  };

  func endHandShowdown(t : Types.Table) {
    setActing(t, null);
    let pots = computePots(t);
    for (pot in pots.vals()) {
      // Best hand among this pot's eligible seats wins it; ties split
      // evenly, remainder (integer division dust) to the first winner in
      // seat order -- consistent, deterministic, no chip ever vanishes.
      var bestScore : ?Cards.HandScore = null;
      var winners : [Nat] = [];
      for (i in pot.eligibleSeats.vals()) {
        let s = t.seats[i];
        let holeArr = switch (s.holeCards) { case (?(a, b)) { [a, b] }; case null { [] } };
        let score = Cards.evaluateBest(Array.concat<Nat8>(holeArr, t.board));
        switch (bestScore) {
          case null { bestScore := ?score; winners := [i] };
          case (?b) {
            switch (Cards.compareHandScore(score, b)) {
              case (#greater) { bestScore := ?score; winners := [i] };
              case (#equal) { winners := Array.concat<Nat>(winners, [i]) };
              case (#less) {};
            };
          };
        };
      };
      let potAfterRake = applyRake(t, pot.amount);
      let share = potAfterRake / winners.size();
      let remainder = potAfterRake % winners.size();
      var first = true;
      for (w in winners.vals()) {
        t.seats[w].stack += share + (if (first) { remainder } else { 0 });
        first := false;
      };
    };
    t.lastResult := ?("Showdown complete");
    Map.add(realShowdownTables, Nat.compare, t.id, true);
    t.phase := #Showdown;
    t.nextHandAt := ?(Time.now() + HAND_PAUSE_NANOS);
  };

  // ---- Timer: enforces action timeouts, starts the next hand after the
  // post-hand pause. The only recurring automation in this canister, same
  // "no manual intervention" spirit as mother/dice's own timers. ----

  // Left over from a 2026-09-09 debugging session (their query methods have
  // been removed) -- keep them declared rather than delete them: Motoko's
  // enhanced orthogonal persistence rejects an upgrade that drops a stable
  // var outright ("RTS error: Memory-incompatible program upgrade"),
  // confirmed directly against this exact canister. Harmless either way.
  var tickCount : Nat = 0;
  var lastTickAt : Int = 0;
  // Guards against two `tickWork()` messages (see startTicker's own
  // comment for why there are now two independent ones a second apart)
  // overlapping if a slow tick ever runs longer than TICK_INTERVAL_SECONDS
  // -- skips a redundant concurrent sweep rather than letting two full
  // per-table loops race each other (dealNextHand's own `dealingTables`
  // lock already rules out the worst case of that, but there's no reason
  // to invite it). `transient`, not stable: correctness never depends on
  // this surviving an upgrade, and a genuine trap inside `tick()` rolls
  // back everything that message did -- including this flag's own
  // `:= true` -- back to whatever it was before that call, so it can
  // never get permanently stuck on trap, only ever reset by finishing.
  transient var tickRunning : Bool = false;
  func tick() : async* () {
    // 2026-09-12: bracketed EVERY branch (not just Showdown, which already
    // had this from 2026-09-10) while hunting a real incident where
    // `timerArmCount`/`timerFireCount` (the schedule itself, confirmed
    // healthy) kept climbing while `tickCount` stayed frozen -- meaning
    // this whole function's body never completes, but with all tables
    // genuinely empty (`dealNextHand`'s own `occupied.size() > 0` guard
    // means the WaitingForPlayers branch prints NOTHING for an empty
    // table, "the overwhelming majority of tick() calls"), log silence
    // alone couldn't distinguish "working normally, quietly" from "stuck
    // early." Logging entry/exit for every table/branch removes that
    // ambiguity -- if this ever hangs again, `icp canister logs` will
    // show exactly which table+branch's log line has an entry with no
    // matching exit, instead of undifferentiated silence.
    Debug.print("tick: start, tickCount=" # debug_show (tickCount + 1) # " tables=" # debug_show (Map.size(tables)));
    tickCount += 1;
    lastTickAt := Time.now();
    for ((_, t) in Map.entries(tables)) {
      // Deliberately OUTSIDE the phase switch below, unlike every other
      // per-table job here -- a sittingOut-but-not-inHand seat can exist
      // regardless of what phase the table's other, active seats have it
      // in (see maybeCleanupSittingOutSeats' own comment).
      await* maybeCleanupSittingOutSeats(t);
      switch (t.phase) {
        case (#WaitingForPlayers) {
          // NOT a self-call here, unlike triggerDeal's other callers --
          // 2026-09-09, tried that first and it was worse: tickCount
          // stopped incrementing entirely within one tick of deploying it
          // (confirmed via getTickDiagnostics), silently killing the
          // *entire* timer including the action-timeout branch below,
          // which had never been broken by anything else this whole
          // incident. Calling `self.someMethod()` from code that's
          // already executing inside a Timer-invoked closure appears to
          // hang rather than complete -- plausibly a reentrancy/call-
          // context issue specific to a canister self-calling itself
          // while a Timer callback for that same canister is still
          // in-flight, though not confirmed beyond this reproduction.
          // Back to a plain local call: the raw_rand-via-timer failure
          // this was meant to route around is real, but WaitingForPlayers
          // dealing now has three working self-call paths (join,
          // sitting back in, triggerDeal itself) that don't depend on
          // this one succeeding -- the timer catching it too is a bonus,
          // not the only path, so it's fine for this specific call to
          // keep failing quietly (logged) rather than hang the clock.
          Debug.print("tick: WaitingForPlayers enter, table=" # debug_show (t.id));
          await* maybeDealNow(t);
          await* maybeCleanupIdleSeats(t);
          Debug.print("tick: WaitingForPlayers done, table=" # debug_show (t.id));
        };
        case (#Showdown) {
          // 2026-09-10: bracketed with logs while hunting the recurring
          // "tick() dies completely" incident (see drawCard's own
          // comment) -- if the timer ever freezes again, whether the
          // "done" line below is the last thing logged (or is missing
          // entirely) narrows this branch in or out fast, instead of
          // guessing blind again. The cleanup itself now lives in
          // maybeCleanupShowdown (shared with triggerDeal -- see its own
          // comment on why a client-callable path to this same cleanup
          // matters, independent of whether the timer itself is healthy).
          Debug.print("tick: Showdown cleanup, table=" # debug_show (t.id) # " handNumber=" # debug_show (t.handNumber));
          await* maybeCleanupShowdown(t);
          Debug.print("tick: Showdown cleanup done, table=" # debug_show (t.id));
        };
        case (_) {
          Debug.print("tick: action-timeout enter, table=" # debug_show (t.id) # " phase=" # debug_show (t.phase));
          await* maybeEnforceActionTimeout(t);
          Debug.print("tick: action-timeout done, table=" # debug_show (t.id));
        };
      };
    };
    Debug.print("tick: end, tickCount=" # debug_show (tickCount));
  };

  // Timers do NOT survive an upgrade (per core/Timer.mo's own doc comment)
  // -- `startTicker` being a bare top-level statement that re-runs on every
  // upgrade is therefore exactly right, not a bug: it's the only way the
  // recurring tick() timer gets re-established after each backend upgrade.
  //
  // 2026-09-12, root-caused for real this time (previous entries below are
  // kept for the record, but their premise turned out to be wrong): every
  // earlier fix here assumed a trap inside `tick()` could be *caught*
  // (logged, tolerated, skipped) from the same closure that reschedules
  // the next tick. It can't. Motoko's `try/catch` only ever catches an
  // `Error` from a *rejected remote call* -- a genuine runtime trap (a
  // `Nat` underflow, an out-of-bounds index, an unwrapped `null`,
  // anywhere in the whole per-table sweep across every table and every
  // phase branch) aborts the ENTIRE enclosing message and rolls back
  // every state change it made, `try/catch` or not -- confirmed the hard
  // way in the 2026-09-10 incident below (a real recurrence with the
  // try/catch already in place, and no "tick(): trapped" log line ever
  // printed, proving it was never reached). Since the old design called
  // `startTicker<system>()` (the reschedule) from INSIDE that same
  // message, right after the `try/catch`, a trap that skipped the catch
  // also always skipped the reschedule -- permanently. No amount of
  // *instrumenting* tick() ever fixes this; the reschedule itself has to
  // stop being able to depend on tick() finishing at all.
  //
  // Fixed by giving the reschedule its own message, with nothing else in
  // it that could ever trap: this closure now ONLY calls
  // `startTicker<system>()` (pure Timer bookkeeping, can't fail) and
  // fires `tickWork()` -- the actual per-table sweep -- as a genuine
  // self-call it does NOT await. An un-awaited call is still sent
  // immediately (Motoko dispatches the message as soon as the call
  // expression runs; `await` only ever governs waiting for the reply,
  // not initiating the send) -- so this closure finishes and commits its
  // own reschedule a moment later regardless of whatever `tickWork()`
  // goes on to do or how long it takes. If `tickWork()` later traps, only
  // ITS OWN message rolls back (that one tick's table-sweep effects,
  // exactly as before) -- the timer that fired it already committed and
  // is completely unaffected, so the very next interval fires normally.
  // This makes the "one trap kills the whole clock forever" failure mode
  // structurally impossible rather than merely logged when it happens.
  //
  // (`await self.something()` -- AWAITING a self-call from inside a
  // Timer-invoked closure -- was tried once before, on a different
  // branch, and appeared to hang rather than complete or trap: plausibly
  // a reentrancy deadlock from a canister awaiting its own reply while
  // still busy processing the very message that sent it. Deliberately
  // NOT done here either, for the same reason -- `tickWork()` below is
  // always fired without awaiting.)
  // 2026-09-12: `timerArmCount`/`timerFireCount` added while chasing a
  // real mainnet incident (see this session's own notes) where the timer
  // appeared dead (`tickCount` frozen) right after a deploy, on a
  // canister that had ticked normally for hours before that -- turned
  // out to be a real but apparently rare/transient one-off (a later
  // redeploy came back healthy, self-sustaining, no code difference), not
  // reproduced despite trying. Left in place permanently rather than
  // reverted once the immediate mystery cleared, matching this file's own
  // established policy on `getTickDiagnostics` below ("don't remove
  // reflexively as leftover debug code") -- these separate `tickCount`
  // (which lives INSIDE the possibly-trapping `tick()` message and would
  // itself misleadingly read as frozen either way) from the schedule
  // itself: if `timerArmCount`/`timerFireCount` are ALSO frozen next time
  // this is reported, the self-rescheduling chain itself is genuinely
  // dead (needs a redeploy, and is worth digging into why); if they're
  // still climbing while `tickCount` is frozen, the schedule is fine and
  // `tick()`'s own per-table work is what's failing instead -- two
  // different problems that looked identical from `tickCount` alone.
  transient var timerArmCount : Nat = 0;
  transient var timerFireCount : Nat = 0;
  // 2026-09-12: real bug, found while root-causing the "timerFireCount
  // climbs, tickCount frozen" mainnet incident (this whole diagnostic's
  // own reason for existing). `ignore self.tickWork()` sends the self-call
  // and never looks at the outcome again -- if that specific call is ever
  // rejected outright (before `tickWork()`'s own body ever starts, so
  // NONE of its internal logging or the `tickRunning` flag are ever
  // touched), the failure is completely invisible: no trap, no log line,
  // nothing -- `tickWork()` (and therefore `tick()`) silently never runs
  // again, forever, while the schedule itself (this closure, and
  // `timerFireCount`) keeps firing normally every second, looking
  // perfectly healthy from that one counter alone. Confirmed this was
  // happening on mainnet, not just theorized: `tickRunning` read `false`
  // on every poll (ruling out a stuck guard) and *zero* of `tick()`'s own
  // new entry/exit prints ever appeared in `icp canister logs` despite
  // `timerFireCount` cycling repeatedly -- the only remaining explanation
  // is the self-call itself never actually landing. Fixed by wrapping the
  // call in its own `async {}` block with a try/catch, still `ignore`d
  // (so this outer timer closure still never awaits anything itself --
  // preserves the fix for the EARLIER reentrancy hang from awaiting a
  // self-call directly inside a timer closure) -- the inner block runs as
  // its own independent async computation once started, so its own
  // eventual reply/reject still gets processed on its own regardless of
  // nothing having awaited the outer future, and a reject now actually
  // gets logged instead of vanishing.
  var timerId : ?Timer.TimerId = null;
  func startTicker<system>() {
    timerArmCount += 1;
    timerId := ?Timer.setTimer<system>(
      #seconds TICK_INTERVAL_SECONDS,
      func() : async () {
        timerFireCount += 1;
        startTicker<system>();
        ignore (
          async {
            try {
              await self.tickWork();
            } catch (e) {
              Debug.print("tick: self-call to tickWork() failed -- " # Error.message(e));
            };
          }
        );
      },
    );
  };
  startTicker<system>();

  // The actual per-table sweep, as a genuine public method so
  // `startTicker`'s closure above can fire it via a real self-call
  // without awaiting it (see that comment for why this split exists).
  // Public and permission-free on purpose, same posture as `triggerDeal`
  // -- a client (or anyone) calling this directly just runs the same safe,
  // idempotent sweep a moment early, no different in kind from the
  // timer's own call.
  // 2026-09-15: real vulnerability, found in a full security audit --
  // `tickRunning` alone only stops CONCURRENT overlap, not rapid
  // SEQUENTIAL spam (call, get the reply, call again immediately) --
  // and this is public with no caller check by design (same reasoning
  // as triggerDeal above), sweeping EVERY table each time. Anyone could
  // call it in a tight loop, for free, and force the canister to keep
  // paying for that full sweep at whatever rate they chose -- a bigger
  // version of the same amplification risk triggerDeal had, worse here
  // since one call costs O(table count) instead of O(1). Throttled to
  // once per TICKWORK_MIN_INTERVAL_NANOS, matching TICK_INTERVAL_SECONDS
  // exactly -- the backend timer's own legitimate calls, and the
  // frontend's slower 5s global nudge, are never throttled; only calls
  // faster than the timer's own natural cadence are.
  transient var lastTickWorkAt : Int = 0;
  let TICKWORK_MIN_INTERVAL_NANOS : Int = 1 * 1_000_000_000;

  public shared func tickWork() : async () {
    // Skips a redundant concurrent sweep if the previous one is still
    // running (see `tickRunning`'s own comment) -- guards against two
    // `tickWork()` messages overlapping if a slow tick ever runs past
    // TICK_INTERVAL_SECONDS, on top of (not instead of) dealNextHand's
    // own per-table `dealingTables` lock.
    if (tickRunning) { return };
    if (Time.now() - lastTickWorkAt < TICKWORK_MIN_INTERVAL_NANOS) { return };
    lastTickWorkAt := Time.now();
    tickRunning := true;
    try {
      await* tick();
    } catch (e) {
      // Still worth keeping: this DOES catch a rejected downstream call
      // (e.g. a ledger transfer failing) inside tick()'s per-table sweep,
      // which is a real, different failure mode from an uncatchable local
      // trap -- logging it here means one table's bad transfer doesn't
      // look identical to a silent freeze in the logs.
      Debug.print("tick(): rejected, skipping this tick -- " # Error.message(e));
    };
    tickRunning := false;
  };

  // Re-exposed 2026-09-09 (see the stable-var comment above) specifically
  // to diagnose this recurring "timer stops advancing" incident -- confirms
  // whether the ticker is actually still firing at all, without guessing.
  // `timerArmCount`/`timerFireCount` (2026-09-12) distinguish "the whole
  // self-rescheduling chain is dead" from "the chain is fine but tick()'s
  // own work keeps failing" -- see their own comment above.
  public query func getTickDiagnostics() : async {
    tickCount : Nat;
    lastTickAt : Int;
    now : Int;
    timerArmCount : Nat;
    timerFireCount : Nat;
    tickRunning : Bool;
  } {
    { tickCount; lastTickAt; now = Time.now(); timerArmCount; timerFireCount; tickRunning };
  };

  // One-shot 2026-09-09 diagnostic: reports exactly what tick()'s own
  // WaitingForPlayers branch would see and decide for one table, in a
  // single atomic snapshot -- to settle whether it's actually reaching a
  // "ready to deal" state that then silently doesn't happen, versus
  // something before that point (not-ready, or not even reaching this
  // table). Remove once this incident is root-caused.
  public query func getDealReadiness(tableId : Nat) : async {
    phase : Text;
    nextHandAt : ?Int;
    ready : Bool;
    activeCount : Nat;
    // Recomputed fresh from occupant/sittingOut/stack, same formula
    // dealNextHand's own post-raw_rand loop uses -- NOT liveSeats(t),
    // whose backing `inHand` field is stale garbage outside of an actual
    // deal attempt (reset false by every Showdown cleanup) and was
    // misleadingly always 0 at rest, telling us nothing real.
    wouldBeLiveCount : Nat;
    seats : [(Bool, Bool, Nat)]; // (occupied, sittingOut, stack) per seat
    now : Int;
  } {
    switch (Map.get(tables, Nat.compare, tableId)) {
      case (?t) {
        let ready = switch (t.nextHandAt) {
          case (?at) { Time.now() >= at };
          case null { true };
        };
        var wouldBeLive = 0;
        for (s in t.seats.vals()) {
          if (s.occupant != null and not s.sittingOut and s.stack > 0) { wouldBeLive += 1 };
        };
        {
          phase = debug_show (t.phase);
          nextHandAt = t.nextHandAt;
          ready;
          activeCount = seatedActiveIndices(t).size();
          wouldBeLiveCount = wouldBeLive;
          seats = Array.map<Types.Seat, (Bool, Bool, Nat)>(
            t.seats,
            func(s) { (s.occupant != null, s.sittingOut, s.stack) },
          );
          now = Time.now();
        };
      };
      case null { Runtime.trap("table not found") };
    };
  };

  // ---- Admin: rake bankroll (same propose/48h-wait/execute/lock shape as
  // dice's own withdrawal path -- controller-only, delayed, cancelable,
  // permanently lockable before blackholing). ----

  let ADMIN_TIMELOCK_NANOS : Int = 48 * 60 * 60 * 1_000_000_000;
  var pendingRakeWithdrawal : ?{ to : Principal; amount : Nat; readyAt : Int } = null;
  var rakeWithdrawalsLocked : Bool = false;

  public query func getRakeBalance() : async Nat { rakeBalance };

  public shared ({ caller }) func proposeRakeWithdrawal(to : Principal, amount : Nat) : async () {
    requireController(caller);
    if (rakeWithdrawalsLocked) { Runtime.trap("rake withdrawals are permanently locked") };
    if (amount > rakeBalance) { Runtime.trap("amount exceeds rake balance") };
    pendingRakeWithdrawal := ?{ to; amount; readyAt = Time.now() + ADMIN_TIMELOCK_NANOS };
  };

  public shared ({ caller }) func cancelPendingRakeWithdrawal() : async () {
    requireController(caller);
    pendingRakeWithdrawal := null;
  };

  // No caller check is intentional (see canViewTable/triggerDeal's own
  // comments for the pattern this project uses elsewhere) -- the
  // destination and amount are already fixed by proposeRakeWithdrawal,
  // controller-only and 48h-timelocked, so anyone executing this just
  // triggers the already-decided transfer; there's no way to redirect it.
  //
  // 2026-09-15: real gap, found in a full security audit -- unlike every
  // player-facing payout in this file (refundOrQueue/claimPendingPayout),
  // a failed transfer here had no recovery path. rakeBalance was already
  // decremented and the pending withdrawal cleared BEFORE the ledger
  // call; if it rejected outright the whole call would trap and the IC's
  // own message atomicity would roll all of that back for free -- but if
  // the ledger replied normally with a business #Err (not a hard reject),
  // this function completed normally too, silently losing that amount
  // from rakeBalance's own books forever even though the PIKO itself
  // never left the canister. Fixed by reusing the exact same
  // pendingPayouts/claimPendingPayout safety net every other payout in
  // this file already relies on, instead of inventing a separate one --
  // a failed withdrawal now just becomes a normal claimable pendingPayout
  // for `to`, retryable the same way a player retries a stuck cash-out.
  public shared ({ caller = _ }) func executeRakeWithdrawal() : async Types.TransferResult {
    switch (pendingRakeWithdrawal) {
      case null { Runtime.trap("no pending rake withdrawal") };
      case (?p) {
        if (Time.now() < p.readyAt) { Runtime.trap("timelock has not elapsed yet") };
        if (rakeWithdrawalsLocked) { Runtime.trap("rake withdrawals are permanently locked") };
        pendingRakeWithdrawal := null;
        rakeBalance -= p.amount;
        let Ledger = ledger();
        let result = try {
          await Ledger.icrc1_transfer({
            from_subaccount = null;
            to = { owner = p.to; subaccount = null };
            amount = p.amount;
            fee = null;
            memo = null;
            created_at_time = null;
          });
        } catch (_e) { #Err(#TemporarilyUnavailable) };
        switch (result) {
          case (#Ok(_)) {};
          case (#Err(_)) {
            let current = switch (Map.get(pendingPayouts, Principal.compare, p.to)) {
              case (?n) { n };
              case null { 0 };
            };
            Map.add(pendingPayouts, Principal.compare, p.to, current + p.amount);
          };
        };
        result;
      };
    };
  };

  public shared ({ caller }) func lockRakeWithdrawals() : async () {
    requireController(caller);
    rakeWithdrawalsLocked := true;
    pendingRakeWithdrawal := null;
  };

  public shared ({ caller }) func setRakeBps(bps : Nat) : async () {
    requireController(caller);
    if (bps > 500) { Runtime.trap("rake capped at 5% by this function itself") };
    rakeBps := bps;
  };

  // One-off cleanup tool for the 2026-09-05 duplicate-table bug (see the
  // seeding guard above) -- traps rather than silently no-op'ing if the
  // table isn't actually empty, so it can never be used to disappear a
  // table with real funds or players still on it.
  public shared ({ caller }) func adminRemoveEmptyTable(tableId : Nat) : async () {
    requireController(caller);
    let t = switch (Map.get(tables, Nat.compare, tableId)) {
      case (?t) { t };
      case null { return };
    };
    for (s in t.seats.vals()) {
      if (s.occupant != null) { Runtime.trap("table has an occupied seat") };
    };
    Map.remove(tables, Nat.compare, tableId);
  };

  // 2026-09-10 recovery lever: clears a principal's pendingFundsActions
  // entry immediately. Since 2026-09-12 this lock also self-expires on its
  // own after PENDING_FUNDS_TIMEOUT_NANOS (see isPendingFundsLocked's own
  // comment) -- this manual lever is now just for impatient/immediate
  // relief rather than the only way out. Safe to call speculatively: a
  // no-op if the principal wasn't actually stuck.
  public shared ({ caller }) func adminClearPendingFunds(target : Principal) : async () {
    requireController(caller);
    clearPendingFunds(target);
  };

  // Admin override to force a stuck/misbehaving seat out, bypassing the
  // normal inHand/hasFolded guard entirely -- reuses doLeave so a real
  // buyIn table still cashes the occupant out correctly, not just Free
  // Play's instant-clear path. Also clears any stale pendingLeaves entry
  // for that seat while at it.
  public shared ({ caller }) func adminKickSeat(tableId : Nat, seatIndex : Nat) : async {
    #Ok : Nat;
    #Queued;
    #Err : Types.LeaveError;
  } {
    requireController(caller);
    let t = switch (Map.get(tables, Nat.compare, tableId)) {
      case (?t) { t };
      case null { return #Err(#NotSeated) };
    };
    let seat = t.seats[seatIndex];
    let occupant = switch (seat.occupant) {
      case (?p) { p };
      case null { return #Err(#NotSeated) };
    };
    Map.remove(pendingLeaves, Text.compare, leaveKey(tableId, occupant));
    let result = await* doLeave(t, seatIndex, occupant);
    // doLeave alone doesn't reset hand-progress fields -- normally
    // unreachable since leaveTable's own guard only ever calls it once
    // inHand is already false or hasFolded is already true. This admin
    // override bypasses that guard entirely (that's the point -- it's for
    // a stuck/misbehaving seat), so clean them explicitly too, or the
    // vacated seat could linger as a phantom "live" contestant (null
    // occupant, still inHand) in liveSeats/computePots.
    seat.hasFolded := false;
    seat.isAllIn := false;
    seat.inHand := false;
    seat.holeCards := null;
    seat.committedThisRound := 0;
    seat.committedThisHand := 0;
    // 2026-09-12: real bug, caught live -- kicking the LAST occupied seat
    // mid-hand left the TABLE itself stuck (phase stayed e.g. #PreFlop,
    // `actingSeat`/`currentBet`/`board` all stale, and the VIEW-only
    // `pots` -- computed from seat commitments, not its own field --
    // stale right along with them) with zero occupants and no way back to
    // #WaitingForPlayers: `dealNextHand`'s own active<2 guard returns
    // early without resetting phase, and
    // Showdown-only cleanup doesn't apply outside #Showdown. Nothing
    // about this specific case (kicking every remaining seat at once) had
    // come up before. Mirrors the same field reset `maybeCleanupShowdown`
    // already uses for its own Showdown->WaitingForPlayers transition,
    // just gated on genuinely zero occupants (checked fresh, after this
    // kick) instead of on phase, since this is a forced admin recovery,
    // not a natural hand-end.
    if (Array.all<Types.Seat>(t.seats, func(s) { s.occupant == null })) {
      t.board := [];
      t.lastResult := null;
      t.phase := #WaitingForPlayers;
      t.nextHandAt := null;
      t.actingSeat := null;
      t.actionDeadline := null;
      t.currentBet := 0;
      t.minRaiseAmount := 0;
      t.toAct := 0;
    };
    result;
  };

  // Manual recovery lever: forces a table stuck in WaitingForPlayers (with
  // enough active seats) to attempt dealing right away via a plain update
  // call, bypassing the tick() timer entirely. Kept permanently after a
  // 2026-09-09 mainnet incident where dealing a fresh hand from
  // WaitingForPlayers never completed via the timer specifically (every
  // other timer-driven step -- action timeouts, the Showdown pause --
  // worked fine, and dealNextHand itself always succeeded instantly when
  // called this way instead) -- root cause not fully confirmed, but this
  // is what actually unstuck the live table, and the switch to a
  // self-rescheduling timer above may not fully rule out a recurrence.
  public shared ({ caller }) func adminForceDealNextHand(tableId : Nat) : async () {
    requireController(caller);
    let t = switch (Map.get(tables, Nat.compare, tableId)) {
      case (?t) { t };
      case null { Runtime.trap("table not found") };
    };
    await* dealNextHand(t);
  };
}
