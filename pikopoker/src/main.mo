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
import VarArray "mo:core/VarArray";
import Runtime "mo:core/Runtime";
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
  var rakeBps : Nat = 200; // 2%
  let rakeCapBigBlinds : Nat = 3;
  var rakeBalance : Nat = 0;
  // A table's buyIn of exactly 0 is the sentinel for a play-money table --
  // see doJoin/leaveTable/topUpStack, which special-case it to skip the
  // ledger entirely. FREE_CHIPS is the complimentary stack a seat gets on
  // sitting down; no real PIKO ever moves for this table.
  let FREE_CHIPS : Nat = 100_000_000_000; // 1,000 chips, same 8-decimal display as PIKO

  // ---- State ----
  var nextTableId : Nat = 0;
  let tables : Map.Map<Nat, Types.Table> = Map.empty<Nat, Types.Table>();
  let privateCodes : Map.Map<Text, Nat> = Map.empty<Text, Nat>();
  // Locks concurrent join/leave/topUp calls from the same principal --
  // same reasoning as dice's pendingBets: set synchronously before the
  // first await so a burst of concurrent calls from one principal can't
  // interleave across the icrc2_transfer_from await.
  let pendingFundsActions : Map.Map<Principal, Bool> = Map.empty<Principal, Bool>();
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
  // A failed payout (cash-out or, in principle, a refund) is recorded here
  // rather than silently lost -- retryable via claimPendingPayout, same
  // pattern mother/dice already use for a failed transfer after funds
  // logically left the game.
  let pendingPayouts : Map.Map<Principal, Nat> = Map.empty<Principal, Nat>();

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

  // ---- Views (hole cards redacted for everyone but the caller, except at showdown) ----

  func seatView(t : Types.Table, seat : Types.Seat, caller : Principal) : Types.SeatView {
    let revealCards = switch (seat.occupant) {
      case (?o) { o == caller or t.phase == #Showdown };
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
      seats = Array.map<Types.Seat, Types.SeatView>(t.seats, func(s) { seatView(t, s, caller) });
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

  public shared query ({ caller }) func getTableView(tableId : Nat) : async ?Types.TableView {
    switch (Map.get(tables, Nat.compare, tableId)) {
      case (?t) { ?tableView(t, caller) };
      case null { null };
    };
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
    if (buyIn < 10_000_000_000 or buyIn > 100_000_000_000_000) { return #Err(#InvalidBuyIn) }; // 100 PIKO .. 1,000,000 PIKO
    let id = nextTableId;
    nextTableId += 1;
    var code = randomCode(id * 7919 + Int.abs(Time.now()) % 1_000_000);
    // Vanishingly unlikely, but don't hand out a colliding code.
    while (Map.get(privateCodes, Text.compare, code) != null) {
      code #= "x";
    };
    let sb = buyIn / 200;
    let bb = buyIn / 100;
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
    } catch (_e) { #Err(#TemporarilyUnavailable) };

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
    if (Map.get(pendingFundsActions, Principal.compare, caller) != null) {
      return #Err(#TransferFailed(#TemporarilyUnavailable));
    };
    Map.add(pendingFundsActions, Principal.compare, caller, true);
    let outcome = switch (Map.get(tables, Nat.compare, tableId)) {
      case null { #Err(#TableNotFound) };
      case (?t) { await* doJoin(t, seatIndex, caller) };
    };
    Map.remove(pendingFundsActions, Principal.compare, caller);
    outcome;
  };

  public shared ({ caller }) func joinPrivateTable(code : Text, seatIndex : Nat) : async {
    #Ok : ();
    #Err : Types.JoinError;
  } {
    if (Principal.isAnonymous(caller)) { return #Err(#Anonymous) };
    if (Map.get(pendingFundsActions, Principal.compare, caller) != null) {
      return #Err(#TransferFailed(#TemporarilyUnavailable));
    };
    Map.add(pendingFundsActions, Principal.compare, caller, true);
    let outcome = switch (findTableByCode(code)) {
      case null { #Err(#TableNotFound) };
      case (?t) { await* doJoin(t, seatIndex, caller) };
    };
    Map.remove(pendingFundsActions, Principal.compare, caller);
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
      return #Ok(0);
    };

    if (Map.get(pendingFundsActions, Principal.compare, caller) != null) { return #Err(#TransferFailed) };
    Map.add(pendingFundsActions, Principal.compare, caller, true);

    let amount = seat.stack;
    seat.occupant := null;
    seat.stack := 0;
    seat.sittingOut := false;

    let Ledger = ledger();
    let fee = try { await Ledger.icrc1_fee() } catch (_e) { 10_000 };
    let payout = if (amount > fee) { amount - fee } else { 0 };
    if (payout > 0) {
      await refundOrQueue(caller, payout);
    };
    Map.remove(pendingFundsActions, Principal.compare, caller);
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
    if (Map.get(pendingFundsActions, Principal.compare, caller) != null) {
      return #Err(#TransferFailed(#TemporarilyUnavailable));
    };
    Map.add(pendingFundsActions, Principal.compare, caller, true);
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
    Map.remove(pendingFundsActions, Principal.compare, caller);
    switch (result) {
      case (#Ok(_)) { t.seats[seatIndex].stack += amount; #Ok(()) };
      case (#Err(e)) { #Err(#TransferFailed(e)) };
    };
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

  public shared ({ caller }) func sitOut(tableId : Nat, sittingOut : Bool) : async { #Ok; #Err : Types.ActionError } {
    let t = switch (Map.get(tables, Nat.compare, tableId)) { case (?t) { t }; case null { return #Err(#NotSeated) } };
    let seatIndex = switch (findSeat(t, caller)) { case (?i) { i }; case null { return #Err(#NotSeated) } };
    t.seats[seatIndex].sittingOut := sittingOut;
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

  func drawCard(t : Types.Table) : Nat8 {
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
    if (active.size() < 2) { return };
    if (t.phase != #WaitingForPlayers) { return };

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
    let entropy = try { await Management.raw_rand() } catch (_e) {
      // Couldn't get randomness -- stay in WaitingForPlayers and try again
      // on the next timer tick rather than dealing with a weak fallback.
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
    if (t.phase != #WaitingForPlayers) { return };

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
    if (liveNow.size() < 2) { t.phase := #WaitingForPlayers; return };

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
    t.toAct := liveNow.size();
    let firstToAct = switch (nextOccupiedFrom(t, bbSeat, true)) { case (?s) { s }; case null { bbSeat } };
    setActing(t, ?firstToAct);
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
    t.seats[seatIndex].hasFolded := true;
    advanceAfterAction(t, seatIndex);
    #Ok;
  };

  public shared ({ caller }) func checkOrCall(tableId : Nat) : async { #Ok; #Err : Types.ActionError } {
    let t = switch (Map.get(tables, Nat.compare, tableId)) { case (?t) { t }; case null { return #Err(#NoHandInProgress) } };
    let seatIndex = switch (requireTurn(t, caller)) { case (?i) { i }; case null { return #Err(#NotYourTurn) } };
    let s = t.seats[seatIndex];
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
      // Action reopens for everyone else still live and not all-in.
      var reopen = 0;
      for (i in liveSeats(t).vals()) {
        if (i != seatIndex and not t.seats[i].isAllIn) { reopen += 1 };
      };
      t.toAct := reopen;
    };
    advanceTurnOnly(t, seatIndex);
    #Ok;
  };

  func advanceTurnOnly(t : Types.Table, actedSeat : Nat) {
    if (t.toAct > 0) { t.toAct -= 1 };
    finishActionAdvance(t, actedSeat);
  };

  func advanceAfterAction(t : Types.Table, actedSeat : Nat) {
    if (t.toAct > 0) { t.toAct -= 1 };
    finishActionAdvance(t, actedSeat);
  };

  func finishActionAdvance(t : Types.Table, actedSeat : Nat) {
    let live = liveSeats(t);
    if (live.size() <= 1) { return endHandByFold(t) };

    var contestants = 0;
    for (i in live.vals()) { if (not t.seats[i].isAllIn) { contestants += 1 } };

    if (t.toAct == 0 or contestants <= 1) {
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
    if (rakeBps == 0 or potAmount == 0) { return potAmount };
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
  func tick() : async* () {
    tickCount += 1;
    lastTickAt := Time.now();
    for ((_, t) in Map.entries(tables)) {
      switch (t.phase) {
        case (#WaitingForPlayers) {
          let ready = switch (t.nextHandAt) {
            case (?at) { Time.now() >= at };
            case null { true };
          };
          if (ready) {
            t.nextHandAt := null;
            await* dealNextHand(t);
          };
        };
        case (#Showdown) {
          switch (t.nextHandAt) {
            case (?at) {
              if (Time.now() >= at) {
                for (s in t.seats.vals()) {
                  s.inHand := false;
                  s.hasFolded := false;
                  s.isAllIn := false;
                  s.committedThisHand := 0;
                  s.committedThisRound := 0;
                  // A stack emptied by the last hand sits out until topped up.
                  if (s.stack == 0 and s.occupant != null) { s.sittingOut := true };
                };
                t.phase := #WaitingForPlayers;
                t.nextHandAt := null;
                await* finalizeQueuedLeaves(t);
              };
            };
            case null {};
          };
        };
        case (_) {
          switch (t.actionDeadline) {
            case (?deadline) {
              if (Time.now() >= deadline) {
                switch (t.actingSeat) {
                  case (?seatIndex) {
                    let s = t.seats[seatIndex];
                    // Auto-check if free, else auto-fold -- never auto-bets.
                    if (t.currentBet <= s.committedThisRound) {
                      advanceAfterAction(t, seatIndex);
                    } else {
                      s.hasFolded := true;
                      advanceAfterAction(t, seatIndex);
                    };
                  };
                  case null {};
                };
              };
            };
            case null {};
          };
        };
      };
    };
  };

  // Timers do NOT survive an upgrade (per core/Timer.mo's own doc comment)
  // -- `startTicker` being a bare top-level statement that re-runs on every
  // upgrade is therefore exactly right, not a bug: it's the only way the
  // recurring tick() timer gets re-established after each backend upgrade.
  //
  // Uses a self-rescheduling one-shot `Timer.setTimer` instead of
  // `Timer.recurringTimer`, which fires on a fixed wall-clock schedule
  // regardless of whether the previous tick() is still resolving --
  // reproduced live on mainnet's Free Play table (2026-09-09): dealing a
  // fresh hand (the one step in tick() with a real cross-canister await,
  // for raw_rand) never completed via the timer, forever, even with every
  // dealing precondition satisfied and the exact same dealNextHand call
  // succeeding instantly and reliably every time it was triggered as a
  // plain update call instead -- root cause not fully confirmed (possibly
  // an interaction specific to a timer-triggered call awaiting a further
  // cross-canister call on mainnet, not reproducible locally), but a
  // self-rescheduling timer that only re-arms once tick() truly finishes
  // structurally rules out that whole class of overlap/interference
  // regardless of the exact mechanism. `adminForceDealNextHand` (below)
  // remains as a manual recovery lever in case a table ever gets stuck
  // again despite this.
  var timerId : ?Timer.TimerId = null;
  func startTicker<system>() {
    timerId := ?Timer.setTimer<system>(
      #seconds TICK_INTERVAL_SECONDS,
      func() : async () {
        await* tick();
        startTicker<system>();
      },
    );
  };
  startTicker<system>();

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

  public shared ({ caller = _ }) func executeRakeWithdrawal() : async Types.TransferResult {
    switch (pendingRakeWithdrawal) {
      case null { Runtime.trap("no pending rake withdrawal") };
      case (?p) {
        if (Time.now() < p.readyAt) { Runtime.trap("timelock has not elapsed yet") };
        if (rakeWithdrawalsLocked) { Runtime.trap("rake withdrawals are permanently locked") };
        pendingRakeWithdrawal := null;
        rakeBalance -= p.amount;
        let Ledger = ledger();
        await Ledger.icrc1_transfer({
          from_subaccount = null;
          to = { owner = p.to; subaccount = null };
          amount = p.amount;
          fee = null;
          memo = null;
          created_at_time = null;
        });
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
