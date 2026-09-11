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
  const [showWallet, setShowWallet] = useState(false);
  const [showRules, setShowRules] = useState(false);

  useEffect(() => {
    getStoredIdentity().then((id) => {
      setIdentity(id);
      setIdentityLoaded(true);
    });
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
          </p>
        )}
      </footer>
    </main>
  );
}

export default App;
