import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";
import Nat "mo:core/Nat";
import Nat8 "mo:core/Nat8";
import Array "mo:core/Array";
import VarArray "mo:core/VarArray";
import Cards "cards";

// Standalone correctness check for cards.mo, run via `moc -r` (not part of
// the deployed canister) -- same verification style this project family
// already used for sha2 (see piko-icp's security review).

var failures = 0;

func check(name : Text, got : Bool) {
  if (not got) {
    Debug.print("FAIL: " # name);
    failures += 1;
  } else {
    Debug.print("ok:   " # name);
  };
};

// rank helpers: 0=2 .. 8=10, 9=J, 10=Q, 11=K, 12=A. suit*13+rank.
func c(suit : Nat, rank : Nat) : Nat8 { Nat8.fromNat(suit * 13 + rank) };

// ---- evaluate5 category checks ----

let highCard = Cards.evaluate5([c(0, 12), c(1, 9), c(2, 7), c(3, 4), c(0, 2)]);
check("high card category", highCard.category == 0);

let onePair = Cards.evaluate5([c(0, 5), c(1, 5), c(2, 9), c(3, 3), c(0, 2)]);
check("one pair category", onePair.category == 1);
check("one pair kicker order", onePair.kickers[0] == 5 and onePair.kickers[2] == 9 and onePair.kickers[3] == 3 and onePair.kickers[4] == 2);

let twoPair = Cards.evaluate5([c(0, 9), c(1, 9), c(2, 4), c(3, 4), c(0, 2)]);
check("two pair category", twoPair.category == 2);
check("two pair kicker order (high pair first)", twoPair.kickers[0] == 9 and twoPair.kickers[2] == 4 and twoPair.kickers[4] == 2);

let trips = Cards.evaluate5([c(0, 7), c(1, 7), c(2, 7), c(3, 9), c(0, 2)]);
check("trips category", trips.category == 3);

let straight = Cards.evaluate5([c(0, 4), c(1, 5), c(2, 6), c(3, 7), c(0, 8)]); // 6-7-8-9-10
check("straight category", straight.category == 4);
check("straight top", straight.kickers[0] == 8);

let wheel = Cards.evaluate5([c(0, 12), c(1, 0), c(2, 1), c(3, 2), c(0, 3)]); // A-2-3-4-5
check("wheel straight category", wheel.category == 4);
check("wheel top is 5 (index 3), not Ace", wheel.kickers[0] == 3);

let flush = Cards.evaluate5([c(2, 12), c(2, 9), c(2, 7), c(2, 4), c(2, 2)]);
check("flush category", flush.category == 5);

let fullHouse = Cards.evaluate5([c(0, 7), c(1, 7), c(2, 7), c(3, 3), c(0, 3)]);
check("full house category", fullHouse.category == 6);
check("full house kicker order (trips rank then pair rank)", fullHouse.kickers[0] == 7 and fullHouse.kickers[3] == 3);

let quads = Cards.evaluate5([c(0, 5), c(1, 5), c(2, 5), c(3, 5), c(0, 9)]);
check("quads category", quads.category == 7);
check("quads kicker", quads.kickers[4] == 9);

let straightFlush = Cards.evaluate5([c(1, 4), c(1, 5), c(1, 6), c(1, 7), c(1, 8)]);
check("straight flush category", straightFlush.category == 8);

// A hand with both a flush AND a straight shape, but NOT in the same suit,
// should score as a flush (5), not a straight (4) or straight flush.
let flushNotStraightFlush = Cards.evaluate5([c(2, 4), c(2, 6), c(2, 7), c(2, 9), c(2, 11)]);
check("non-consecutive flush is category 5", flushNotStraightFlush.category == 5);

// ---- compareHandScore ordering sanity ----
check("quads beats full house", Cards.compareHandScore(quads, fullHouse) == #greater);
check("full house beats flush", Cards.compareHandScore(fullHouse, flush) == #greater);
check("flush beats straight", Cards.compareHandScore(flush, straight) == #greater);
check("straight beats trips", Cards.compareHandScore(straight, trips) == #greater);
check("straight flush beats quads", Cards.compareHandScore(straightFlush, quads) == #greater);

let higherPair = Cards.evaluate5([c(0, 9), c(1, 9), c(2, 4), c(3, 3), c(0, 2)]);
let lowerPair = Cards.evaluate5([c(0, 5), c(1, 5), c(2, 9), c(3, 3), c(0, 2)]);
check("higher pair rank beats lower pair rank", Cards.compareHandScore(higherPair, lowerPair) == #greater);

let samePairBetterKicker = Cards.evaluate5([c(0, 5), c(1, 5), c(2, 12), c(3, 3), c(0, 2)]);
check("same pair, better kicker wins", Cards.compareHandScore(samePairBetterKicker, onePair) == #greater);

// ---- evaluateBest over 7 cards (2 hole + 5 board) ----
// Board makes a straight; one player's hole cards improve it to a flush.
let board = [c(2, 4), c(2, 6), c(0, 7), c(2, 9), c(2, 11)];
let holeMakesFlush = [c(2, 2), c(1, 0)];
let holePlain = [c(0, 0), c(1, 1)];
let bestFlush = Cards.evaluateBest(Array.flatten<Nat8>([holeMakesFlush, board]));
let bestPlain = Cards.evaluateBest(Array.flatten<Nat8>([holePlain, board]));
check("evaluateBest finds the flush across 7 cards", bestFlush.category == 5);
check("evaluateBest correctly does NOT find a flush for the other hand", bestPlain.category != 5);
check("flush-holder beats plain-holder at showdown", Cards.compareHandScore(bestFlush, bestPlain) == #greater);

// ---- shuffle sanity: same 52 cards present, deterministic given the same seed ----
let deckA = VarArray.fromArray<Nat8>(Cards.freshDeck());
Cards.shuffle(deckA, 123456789);
let deckB = VarArray.fromArray<Nat8>(Cards.freshDeck());
Cards.shuffle(deckB, 123456789);
var sameSeedSameResult = true;
var i = 0;
while (i < 52) {
  if (deckA[i] != deckB[i]) { sameSeedSameResult := false };
  i += 1;
};
check("shuffle is deterministic given the same seed", sameSeedSameResult);

let deckC = VarArray.fromArray<Nat8>(Cards.freshDeck());
Cards.shuffle(deckC, 987654321);
var differentSeedDifferentResult = false;
i := 0;
while (i < 52) {
  if (deckA[i] != deckC[i]) { differentSeedDifferentResult := true };
  i += 1;
};
check("shuffle differs given a different seed", differentSeedDifferentResult);

let seen = VarArray.tabulate<Bool>(52, func _ = false);
for (card in deckA.vals()) { seen[Nat8.toNat(card)] := true };
var allPresent = true;
i := 0;
while (i < 52) {
  if (not seen[i]) { allPresent := false };
  i += 1;
};
check("shuffled deck still contains all 52 distinct cards", allPresent);

if (failures > 0) {
  Debug.print(Nat.toText(failures) # " FAILURE(S)");
  Runtime.trap("test_cards.mo: failures detected, see output above");
} else {
  Debug.print("all cards.mo checks passed");
};
