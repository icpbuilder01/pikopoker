import { useCallback, useEffect, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { getLedgerActor, getPikopokerActor } from "./lib/actors";
import { login, logout, getStoredIdentity } from "./lib/auth";
import { Lobby } from "./components/Lobby";
import { TableRoom } from "./components/TableRoom";
import { Wallet } from "./components/Wallet";
import { Rules } from "./components/Rules";
import { ChipAmount } from "./components/ChipAmount";
import "./App.css";

type View = { type: "lobby" } | { type: "table"; tableId: bigint; code?: string };

function viewFromLocation(): View {
  const params = new URLSearchParams(window.location.search);
  const tableParam = params.get("table");
  if (tableParam && /^\d+$/.test(tableParam)) {
    const code = params.get("code");
    return { type: "table", tableId: BigInt(tableParam), code: code ?? undefined };
  }
  return { type: "lobby" };
}

function pushView(view: View) {
  const url = view.type === "table" ? `?table=${view.tableId.toString()}${view.code ? `&code=${view.code}` : ""}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}

function App() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [identityLoaded, setIdentityLoaded] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [view, setView] = useState<View>(() => viewFromLocation());
  const [claimMessage, setClaimMessage] = useState<string | null>(null);
  const [unstickMessage, setUnstickMessage] = useState<string | null>(null);
  const [showWallet, setShowWallet] = useState(false);
  const [showRules, setShowRules] = useState(false);

  useEffect(() => {
    getStoredIdentity().then((id) => {
      setIdentity(id);
      setIdentityLoaded(true);
    });
  }, []);

  // 2026-09-12: real backend bug, found while investigating a mainnet
  // report -- the recurring timer's OWN attempt to trigger its per-table
  // sweep (`tickWork()`) is a genuine inter-canister self-call, made from
  // code that originates inside a Timer-invoked closure; on mainnet
  // (never reproduced on the local replica) that specific call appears to
  // never resolve at all -- not reject, not trap, just silently never
  // complete -- so the sweep never runs again after the first time this
  // happens, even though the timer's own recurring schedule (proven
  // separately healthy via the backend's own diagnostics) keeps firing on
  // schedule forever. A perfectly ordinary EXTERNAL call to `tickWork()`
  // (this one) has none of that self-call baggage and reliably works --
  // confirmed directly, repeatedly, via `icp canister call` while
  // diagnosing this. So: nudge it from here, unconditionally, as long as
  // *anyone* has the site open at all (not gated on being logged in or
  // seated anywhere -- this covers every table, not just whichever one a
  // given visitor happens to be looking at). Mirrors the same "cheap,
  // safe to call even when there's nothing to do" reasoning already
  // established for `TableRoom.tsx`'s own per-table `triggerDeal` nudge.
  useEffect(() => {
    const id = setInterval(() => {
      getPikopokerActor().tickWork().catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, []);

  const refreshBalance = useCallback(async (id: Identity) => {
    try {
      const ledger = getLedgerActor();
      const raw = await ledger.icrc1_balance_of({ owner: id.getPrincipal() });
      setBalance(raw);
    } catch (err) {
      console.error("Failed to fetch PIKO balance", err);
    }
  }, []);

  useEffect(() => {
    if (!identity) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting to "not loaded" on logout, not derived state
      setBalance(null);
      return;
    }
    refreshBalance(identity);
    const id = setInterval(() => refreshBalance(identity), 6000);
    return () => clearInterval(id);
  }, [identity, refreshBalance]);

  // 2026-09-15: real UX bug -- "Claim a stuck payout" in the footer is
  // ALWAYS visible whenever logged in (see below), which made it look like
  // a required manual step after every leave, even though it's a no-op
  // 99% of the time (nothing pending most leaves succeed normally). Sweep
  // it automatically once per login instead of requiring a click -- silent
  // unless it actually finds something, same claimPendingPayout() call the
  // manual button uses, just fired proactively.
  useEffect(() => {
    if (!identity) return;
    getPikopokerActor(identity)
      .claimPendingPayout()
      .then((result) => {
        if (result.__kind__ === "Ok") {
          setClaimMessage("Found and claimed a pending payout -- check your balance.");
          refreshBalance(identity);
        }
      })
      .catch(() => {});
  }, [identity, refreshBalance]);

  async function handleLogin(): Promise<Identity | null> {
    const id = await login();
    setIdentity(id);
    return id;
  }

  async function handleLogout() {
    await logout();
    setIdentity(null);
  }

  function openTable(tableId: bigint, code?: string) {
    const next: View = { type: "table", tableId, code };
    setView(next);
    pushView(next);
  }

  function goToLobby() {
    const next: View = { type: "lobby" };
    setView(next);
    pushView(next);
  }

  async function handleClaimPayout() {
    if (!identity) return;
    setClaimMessage("Checking for a pending payout...");
    try {
      const result = await getPikopokerActor(identity).claimPendingPayout();
      if (result.__kind__ === "Ok") {
        setClaimMessage("Payout claimed -- check your balance.");
        refreshBalance(identity);
      } else {
        setClaimMessage("Nothing pending to claim right now.");
      }
    } catch (err) {
      console.error("Claim payout failed", err);
      setClaimMessage("Couldn't check for a pending payout -- try again later.");
    }
  }

  // Self-service unstick for the pendingFundsActions lock (see
  // clearMyStuckPendingFunds's own comment in main.mo) -- safe to expose as
  // a plain button because the backend only ever clears an entry it already
  // treats as expired, so this can't jump the queue on a genuinely
  // in-flight join/leave/top-up, only save a player from having to guess
  // when it's safe to retry (useful away from a computer, e.g. on a phone).
  async function handleClearStuckLock() {
    if (!identity) return;
    setUnstickMessage("Checking...");
    try {
      const cleared = await getPikopokerActor(identity).clearMyStuckPendingFunds();
      setUnstickMessage(cleared ? "Cleared -- try your action again." : "Nothing stuck right now.");
    } catch (err) {
      console.error("Clear stuck lock failed", err);
      setUnstickMessage("Couldn't check -- try again later.");
    }
  }

  return (
    <main className={`page${view.type === "table" ? " in-table" : ""}`}>
      {showWallet && identity && (
        <Wallet
          identity={identity}
          balance={balance}
          onClose={() => setShowWallet(false)}
          onBalanceChange={() => refreshBalance(identity)}
        />
      )}
      {showRules && <Rules onClose={() => setShowRules(false)} />}

      <header className="header">
        <button className="brand" onClick={goToLobby}>
          <img src="/piko-logo.svg" alt="" className="brand-logo" />
          <div className="brand-text">
            <span className="brand-name">&#127183; PikoPoker</span>
            <span className="brand-ticker">No-Limit Hold'em, bet in PIKO</span>
          </div>
        </button>
        <div className="wallet-box">
          <button className="button secondary small" onClick={() => setShowRules(true)}>
            Rules
          </button>
          {identity && (
            <button className="button secondary small wallet-balance-button" onClick={() => setShowWallet(true)}>
              {balance !== null ? <ChipAmount amount={balance} unit="PIKO" /> : "Wallet"}
            </button>
          )}
          {identity ? (
            <button className="button secondary" onClick={handleLogout}>
              Log out
            </button>
          ) : (
            identityLoaded && (
              <button className="button" onClick={handleLogin}>
                Log in with Internet Identity
              </button>
            )
          )}
        </div>
      </header>

      {!identityLoaded ? (
        <div className="empty-state">Loading...</div>
      ) : (
        <>
          {view.type === "lobby" && !identity && (
            <section className="hero">
              <div className="tag-row">
                <span className="tag">On-chain, no house edge secrets</span>
                <span className="tag spark">Public &amp; private tables</span>
                <span className="tag">2-8 player tables</span>
              </div>
              <h1>Take a seat.</h1>
              <p>
                No-Limit Texas Hold'em, bet in PIKO, running entirely on-chain on the Internet
                Computer. Sit at a public table with a fixed stake, or start a private table and
                share the invite link with friends. Spectate any table without logging in -- log
                in with Internet Identity when you're ready to buy in.
              </p>
            </section>
          )}

          {view.type === "lobby" ? (
            <Lobby identity={identity} onLogin={handleLogin} onOpenTable={openTable} />
          ) : (
            <TableRoom
              tableId={view.tableId}
              identity={identity}
              privateCode={view.code}
              onBack={goToLobby}
              onLogin={handleLogin}
            />
          )}
        </>
      )}

      <footer className="footer">
        <p>
          PikoPoker escrows buy-ins on-chain for the duration of a hand -- see the project README
          for the full custody and fairness model (raw_rand-shuffled decks, hole cards redacted
          from every query but your own).
        </p>
        {identity && (
          <p>
            <button className="footer-link" onClick={handleClaimPayout}>
              Claim a stuck payout
            </button>
            {claimMessage && <span> -- {claimMessage}</span>}
            {" "}&middot;{" "}
            <button className="footer-link" onClick={handleClearStuckLock}>
              Stuck on "still finishing"? Clear it
            </button>
            {unstickMessage && <span> -- {unstickMessage}</span>}
          </p>
        )}
      </footer>
    </main>
  );
}

export default App;
