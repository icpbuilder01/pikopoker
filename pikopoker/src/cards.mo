import Nat8 "mo:core/Nat8";
import Array "mo:core/Array";
import VarArray "mo:core/VarArray";
import Order "mo:core/Order";

// Deck, shuffle, and 7-card Texas Hold'em hand evaluation -- a pure module
// with no actor/canister state, so it can be unit-tested standalone with
// `moc -r` (see test_cards.mo) the same way this project family already
// verified sha2 correctness that way (see piko-icp's security review).
//
// A card is a Nat8 0..51: rank = card % 13 (0 = "2" ... 12 = Ace),
// suit = card / 13 (0..3, arbitrary suit order -- only the frontend's
// rendering needs to agree with it, gameplay never depends on suit
// identity beyond "same suit or not").
module {

  public func rankOf(c : Nat8) : Nat = Nat8.toNat(c) % 13;
  public func suitOf(c : Nat8) : Nat = Nat8.toNat(c) / 13;

  public func freshDeck() : [Nat8] {
    Array.tabulate<Nat8>(52, func(i) { Nat8.fromNat(i) });
  };

  // Fisher-Yates driven by one big arbitrary-precision integer built from
  // raw_rand's 32 bytes (256 bits of real threshold randomness -- see
  // ../src/main.mo's dealNextHand). Treating that integer as a mixed-radix
  // number and peeling off `n % (i+1)` / dividing by `(i+1)` at each step
  // consumes the entropy exactly, with no modulo-bias the way naively
  // taking `byte % range` per swap would have. 52! is about 2^225.6, well
  // under the 2^256 the seed provides, so this fully determines an
  // unbiased permutation with room to spare.
  public func shuffle(deck : [var Nat8], seed : Nat) {
    var n = seed;
    var i = deck.size();
    while (i > 1) {
      i -= 1;
      let j = n % (i + 1);
      n := n / (i + 1);
      let tmp = deck[i];
      deck[i] := deck[j];
      deck[j] := tmp;
    };
  };

  public func entropyToNat(bytes : [Nat8]) : Nat {
    var n : Nat = 0;
    for (b in bytes.vals()) { n := n * 256 + Nat8.toNat(b) };
    n;
  };

  // ---- Hand evaluation ----

  // category: 0 high card .. 8 straight flush (higher is better).
  // kickers: tiebreak ranks in comparison order (compare element by
  // element, first difference decides) -- always length 5, always the
  // right tiebreak sequence for hands sharing the same category, see
  // evaluate5's comment on how it's built.
  public type HandScore = { category : Nat; kickers : [Nat] };

  public func compareHandScore(a : HandScore, b : HandScore) : Order.Order {
    if (a.category != b.category) {
      return if (a.category < b.category) { #less } else { #greater };
    };
    var i = 0;
    while (i < a.kickers.size() and i < b.kickers.size()) {
      if (a.kickers[i] != b.kickers[i]) {
        return if (a.kickers[i] < b.kickers[i]) { #less } else { #greater };
      };
      i += 1;
    };
    #equal;
  };

  // ranks sorted descending, deduped, e.g. for straight detection.
  func distinctRanksDesc(ranks : [Nat]) : [Nat] {
    let seen = VarArray.tabulate<Bool>(13, func _ = false);
    for (r in ranks.vals()) { seen[r] := true };
    let buf = VarArray.tabulate<Nat>(13, func _ = 0);
    var n = 0;
    var r = 13;
    while (r > 0) {
      r -= 1;
      if (seen[r]) { buf[n] := r; n += 1 };
    };
    Array.tabulate<Nat>(n, func(i) { buf[i] });
  };

  // Returns the top rank of a straight found in `ranksDesc` (distinct,
  // descending), or null. Handles the wheel (A-2-3-4-5) as top rank 3
  // ("5"), since the Ace plays low there, not as a 14.
  func straightTop(ranksDesc : [Nat]) : ?Nat {
    var run = 1;
    var i = 0;
    while (i + 1 < ranksDesc.size()) {
      if (ranksDesc[i] == ranksDesc[i + 1] + 1) {
        run += 1;
        if (run >= 5) { return ?ranksDesc[i - 3] };
      } else {
        run := 1;
      };
      i += 1;
    };
    // Wheel: needs A(12),4,3,2 present alongside the low ranks 3,2,1,0 --
    // distinctRanksDesc is sorted descending so Ace (12) is first if present.
    if (ranksDesc.size() >= 5 and ranksDesc[0] == 12) {
      let hasRank = func(target : Nat) : Bool {
        for (r in ranksDesc.vals()) { if (r == target) return true };
        false;
      };
      if (hasRank(3) and hasRank(2) and hasRank(1) and hasRank(0)) { return ?3 };
    };
    null;
  };

  // Evaluates exactly 5 cards.
  public func evaluate5(cards : [Nat8]) : HandScore {
    let ranks = Array.map<Nat8, Nat>(cards, rankOf);
    let suits = Array.map<Nat8, Nat>(cards, suitOf);
    let isFlush = suits[0] == suits[1] and suits[0] == suits[2] and suits[0] == suits[3] and suits[0] == suits[4];

    let counts = VarArray.tabulate<Nat>(13, func _ = 0);
    for (r in ranks.vals()) { counts[r] += 1 };

    // Generic kicker order for ANY category: ranks sorted by (count desc,
    // rank desc) -- correctly orders quad/trips/pair kickers, two-pair's
    // two pairs then the odd card, and plain high-card hands, all with the
    // same rule.
    let byCountThenRank = func(x : Nat, y : Nat) : Order.Order {
      if (counts[x] != counts[y]) {
        return if (counts[x] > counts[y]) { #less } else { #greater };
      };
      if (x != y) { return if (x > y) { #less } else { #greater } };
      #equal;
    };
    // Sorting the 5 raw ranks (duplicates included) by (count desc, rank
    // desc) gives the correct tiebreak sequence for every category: a
    // pair/trips/quads rank sorts to the front (repeated, which is
    // harmless), then the remaining kickers descending -- verified case by
    // case in test_cards.mo.
    let genericKickers = Array.sort<Nat>(ranks, byCountThenRank);

    let ranksDesc = distinctRanksDesc(ranks);
    let straightTopRank = if (ranksDesc.size() == 5) { straightTop(ranksDesc) } else { null };

    let sortedCounts = Array.sort<Nat>(
      Array.tabulate<Nat>(13, func(i) { counts[i] }),
      func(x, y) { if (x > y) { #less } else if (x < y) { #greater } else { #equal } },
    );
    let shape = Array.filter<Nat>(sortedCounts, func(c) { c > 0 });

    switch (straightTopRank, isFlush) {
      case (?top, true) { { category = 8; kickers = [top, 0, 0, 0, 0] } };
      case (_, _) {
        if (shape.size() >= 2 and shape[0] == 4) {
          { category = 7; kickers = genericKickers };
        } else if (shape.size() >= 2 and shape[0] == 3 and shape[1] == 2) {
          { category = 6; kickers = genericKickers };
        } else if (isFlush) {
          { category = 5; kickers = Array.sort<Nat>(ranks, func(x, y) { if (x > y) { #less } else if (x < y) { #greater } else { #equal } }) };
        } else switch (straightTopRank) {
          case (?top) { { category = 4; kickers = [top, 0, 0, 0, 0] } };
          case null {
            if (shape.size() >= 1 and shape[0] == 3) {
              { category = 3; kickers = genericKickers };
            } else if (shape.size() >= 2 and shape[0] == 2 and shape[1] == 2) {
              { category = 2; kickers = genericKickers };
            } else if (shape.size() >= 1 and shape[0] == 2) {
              { category = 1; kickers = genericKickers };
            } else {
              { category = 0; kickers = genericKickers };
            };
          };
        };
      };
    };
  };

  // Best 5-card score out of `cards.size()` cards (7 for hold'em: 2 hole +
  // 5 board), by brute-forcing every 5-card combination -- simple and
  // cheap (21 combinations for 7 cards) rather than a hand-optimized
  // single-pass evaluator, correctness over micro-optimization for a
  // 6-seat table.
  public func evaluateBest(cards : [Nat8]) : HandScore {
    let n = cards.size();
    var best : ?HandScore = null;
    let combo = VarArray.tabulate<Nat8>(5, func _ = 0);
    func recurse(start : Nat, chosen : Nat) {
      if (chosen == 5) {
        let score = evaluate5(Array.tabulate<Nat8>(5, func(i) { combo[i] }));
        switch (best) {
          case null { best := ?score };
          case (?b) { if (compareHandScore(score, b) == #greater) { best := ?score } };
        };
        return;
      };
      var i = start;
      while (i < n) {
        combo[chosen] := cards[i];
        recurse(i + 1, chosen + 1);
        i += 1;
      };
    };
    recurse(0, 0);
    switch (best) {
      case (?b) { b };
      case null { { category = 0; kickers = [0, 0, 0, 0, 0] } }; // unreachable for n >= 5
    };
  };
}
