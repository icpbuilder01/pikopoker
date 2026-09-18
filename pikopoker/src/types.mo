module {
  /// Same minimal ICRC-1/ICRC-2 interface the rest of this family of
  /// projects declares locally per canister (piko-icp's own convention,
  /// see mother/dice's types.mo) rather than importing cross-canister.
  public type Account = { owner : Principal; subaccount : ?Blob };

  public type TransferArg = {
    from_subaccount : ?Blob;
    to : Account;
    amount : Nat;
    fee : ?Nat;
    memo : ?Blob;
    created_at_time : ?Nat64;
  };

  public type TransferError = {
    #BadFee : { expected_fee : Nat };
    #BadBurn : { min_burn_amount : Nat };
    #InsufficientFunds : { balance : Nat };
    #TooOld;
    #CreatedInFuture : { ledger_time : Nat64 };
    #TemporarilyUnavailable;
    #Duplicate : { duplicate_of : Nat };
    #GenericError : { error_code : Nat; message : Text };
  };

  public type TransferResult = { #Ok : Nat; #Err : TransferError };

  public type TransferFromArgs = {
    spender_subaccount : ?Blob;
    from : Account;
    to : Account;
    amount : Nat;
    fee : ?Nat;
    memo : ?Blob;
    created_at_time : ?Nat64;
  };

  public type TransferFromError = {
    #BadFee : { expected_fee : Nat };
    #BadBurn : { min_burn_amount : Nat };
    #InsufficientFunds : { balance : Nat };
    #InsufficientAllowance : { allowance : Nat };
    #TooOld;
    #CreatedInFuture : { ledger_time : Nat64 };
    #Duplicate : { duplicate_of : Nat };
    #TemporarilyUnavailable;
    #GenericError : { error_code : Nat; message : Text };
  };

  public type TransferFromResult = { #Ok : Nat; #Err : TransferFromError };

  public type LedgerActor = actor {
    icrc1_transfer : shared TransferArg -> async TransferResult;
    icrc2_transfer_from : shared TransferFromArgs -> async TransferFromResult;
    icrc1_fee : shared query () -> async Nat;
  };

  public type ManagementActor = actor {
    raw_rand : () -> async Blob;
  };

  // ---- Table / game state ----

  public let MAX_SEATS : Nat = 6;

  public type TableKind = { #Public; #Private : { code : Text } };

  public type Phase = {
    #WaitingForPlayers;
    #PreFlop;
    #Flop;
    #Turn;
    #River;
    #Showdown;
  };

  public type Seat = {
    var occupant : ?Principal;
    var stack : Nat; // chips at the table, not yet committed to the current hand
    var holeCards : ?(Nat8, Nat8);
    var committedThisRound : Nat; // chips put in during the current betting round
    var committedThisHand : Nat; // chips put in across the whole hand, for side pots
    var hasFolded : Bool;
    var isAllIn : Bool;
    var inHand : Bool; // dealt into the hand currently in progress
    var sittingOut : Bool; // opted out of being dealt into the next hand
  };

  public type SeatView = {
    occupant : ?Principal;
    stack : Nat;
    holeCards : ?(Nat8, Nat8); // only populated for the caller's own seat, or at showdown
    committedThisRound : Nat;
    committedThisHand : Nat;
    hasFolded : Bool;
    isAllIn : Bool;
    inHand : Bool;
    sittingOut : Bool;
    afkTimeouts : Nat;
  };

  public type Pot = { amount : Nat; eligibleSeats : [Nat] };

  public type Table = {
    id : Nat;
    var name : Text;
    kind : TableKind;
    buyIn : Nat;
    smallBlind : Nat;
    bigBlind : Nat;
    seats : [Seat];
    var phase : Phase;
    var board : [Nat8];
    var deck : [Nat8]; // remaining undealt cards, never exposed via any query
    var dealerSeat : Nat;
    var actingSeat : ?Nat;
    var actionDeadline : ?Int;
    var currentBet : Nat;
    var minRaiseAmount : Nat; // size of the last bet/raise, for min-raise sizing
    var toAct : Nat; // how many live, non-all-in seats still need to act this round
    var handNumber : Nat;
    var lastResult : ?Text;
    var nextHandAt : ?Int; // post-hand pause, or "ready whenever 2+ are seated" when null in WaitingForPlayers
  };

  public type TableView = {
    id : Nat;
    name : Text;
    kind : TableKind;
    buyIn : Nat;
    smallBlind : Nat;
    bigBlind : Nat;
    phase : Phase;
    seats : [SeatView];
    board : [Nat8];
    dealerSeat : Nat;
    actingSeat : ?Nat;
    actionDeadline : ?Int;
    currentBet : Nat;
    minRaiseTo : Nat;
    pots : [Pot];
    handNumber : Nat;
    lastResult : ?Text; // short human-readable summary of the last showdown/fold win, for the UI
  };

  public type TableSummary = {
    id : Nat;
    name : Text;
    kind : TableKind;
    buyIn : Nat;
    smallBlind : Nat;
    bigBlind : Nat;
    seatsTaken : Nat;
    phase : Phase;
  };

  public type JoinError = {
    #TableNotFound;
    #SeatTaken;
    #SeatOutOfRange;
    #AlreadySeatedAtTable;
    #WrongBuyInAmount;
    #TransferFailed : TransferFromError;
    #Anonymous;
  };

  public type LeaveError = {
    #NotSeated;
    #StillInHand;
    #TransferFailed;
  };

  public type ActionError = {
    #NotSeated;
    #NotYourTurn;
    #NoHandInProgress;
    #IllegalAction : Text;
  };

  public type CreatePrivateError = { #Anonymous; #InvalidBuyIn; #InvalidName; #TemporarilyUnavailable };

  // ---- Per-table chat ----

  public type ChatMessage = {
    sender : Principal;
    text : Text;
    timestamp : Int; // Time.now(), nanoseconds
  };

  public type ChatError = { #Anonymous; #TableNotFound; #EmptyMessage; #MessageTooLong };
}
