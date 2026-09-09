import { useEffect, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { getPikopokerActor } from "../lib/actors";
import { frontendUrl } from "../lib/canister-env";
import { formatPiko, parseAmount } from "../lib/format";
import { CreatePrivateError, Phase, type TableSummary } from "../bindings/pikopoker/pikopoker";
import { QrCode } from "./QrCode";

interface LobbyProps {
  identity: Identity | null;
  onLogin: () => Promise<Identity | null>;
  onOpenTable: (tableId: bigint, privateCode?: string) => void;
}

const POLL_MS = 5000;
// Mirrors pikopoker/src/types.mo's Types.MAX_SEATS -- TableSummary doesn't
// carry a seat count, so this has to be kept in sync by hand.
const TABLE_SEATS = 8;

function phaseTag(p: Phase): string {
  switch (p) {
    case Phase.WaitingForPlayers:
      return "Waiting";
    case Phase.Showdown:
      return "Showdown";
    default:
      return "In hand";
  }
}

function createErrorMessage(err: CreatePrivateError): string {
  switch (err) {
    case CreatePrivateError.Anonymous:
      return "Log in first.";
    case CreatePrivateError.InvalidBuyIn:
      return "Buy-in must be between 100 and 1,000,000 PIKO.";
    case CreatePrivateError.InvalidName:
      return "Enter a table name (1-32 characters).";
    default:
      return "Couldn't create the table.";
  }
}

function parseInvite(input: string): { tableId: bigint; code?: string } | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed);
    const tParam = url.searchParams.get("table");
    if (tParam && /^\d+$/.test(tParam)) {
      const code = url.searchParams.get("code");
      return { tableId: BigInt(tParam), code: code ?? undefined };
    }
  } catch {
    // Not a URL -- fall through to the bare-number case below.
  }
  if (/^\d+$/.test(trimmed)) return { tableId: BigInt(trimmed) };
  return null;
}

export function Lobby({ identity, onLogin, onOpenTable }: LobbyProps) {
  const [publicTables, setPublicTables] = useState<TableSummary[] | null>(null);
  const [myPrivateTables, setMyPrivateTables] = useState<TableSummary[] | null>(null);

  const [createName, setCreateName] = useState("");
  const [createBuyIn, setCreateBuyIn] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createResult, setCreateResult] = useState<{ id: bigint; code: string } | null>(null);
  const [copiedCreated, setCopiedCreated] = useState(false);

  const [inviteInput, setInviteInput] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const tables = await getPikopokerActor().getLobby();
        if (!cancelled) setPublicTables(tables);
      } catch (err) {
        console.error("Failed to load lobby", err);
      }
    }
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!identity) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting to "not loaded" on logout, not derived state
      setMyPrivateTables(null);
      return;
    }
    let cancelled = false;
    async function load(id: Identity) {
      try {
        const tables = await getPikopokerActor(id).getMyPrivateTables();
        if (!cancelled) setMyPrivateTables(tables);
      } catch (err) {
        console.error("Failed to load private tables", err);
      }
    }
    load(identity);
    const timer = setInterval(() => load(identity), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [identity]);

  async function handleCreate() {
    setCreateError(null);
    const id = identity ?? (await onLogin());
    if (!id) {
      setCreateError("Log in first.");
      return;
    }
    const name = createName.trim();
    const buyIn = parseAmount(createBuyIn);
    if (name.length === 0) {
      setCreateError("Enter a table name.");
      return;
    }
    if (buyIn === null) {
      setCreateError("Enter a valid buy-in amount.");
      return;
    }
    setCreating(true);
    try {
      const result = await getPikopokerActor(id).createPrivateTable(name, buyIn);
      if (result.__kind__ === "Err") {
        setCreateError(createErrorMessage(result.Err));
      } else {
        setCreateResult(result.Ok);
      }
    } catch (err) {
      console.error("Create table failed", err);
      setCreateError("Couldn't create the table -- try again.");
    } finally {
      setCreating(false);
    }
  }

  async function handleCopyCreated() {
    if (!createResult) return;
    const link = `${frontendUrl}?table=${createResult.id.toString()}&code=${createResult.code}`;
    try {
      await navigator.clipboard.writeText(link);
      setCopiedCreated(true);
      setTimeout(() => setCopiedCreated(false), 2000);
    } catch (err) {
      console.error("Copy failed", err);
    }
  }

  function handleJoinInvite() {
    setInviteError(null);
    const parsed = parseInvite(inviteInput);
    if (!parsed) {
      setInviteError("Paste a valid invite link or a table number.");
      return;
    }
    onOpenTable(parsed.tableId, parsed.code);
  }

  return (
    <>
      <section className="block">
        <h2>Public tables</h2>
        {publicTables === null ? (
          <p className="empty-state">Loading tables...</p>
        ) : publicTables.length === 0 ? (
          <p className="empty-state">No public tables yet.</p>
        ) : (
          <ul className="table-list">
            {publicTables.map((t) => (
              <li key={t.id.toString()}>
                <button className="table-row" onClick={() => onOpenTable(t.id)}>
                  <span className={`table-row-badge ${t.buyIn === 0n ? "free" : ""}`}>
                    {t.buyIn === 0n ? "Free" : "Public"}
                  </span>
                  <span className="table-row-name">
                    <strong>{t.name}</strong>
                    <span className="table-row-stakes">
                      {t.buyIn === 0n
                        ? "No real PIKO -- complimentary chips every time you sit down"
                        : `${formatPiko(t.smallBlind)}/${formatPiko(t.bigBlind)} · ${formatPiko(t.buyIn)} PIKO buy-in`}
                    </span>
                  </span>
                  <span className="table-row-seats">{t.seatsTaken.toString()}/{TABLE_SEATS}</span>
                  <span className="table-row-phase">{phaseTag(t.phase)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {identity && (
        <section className="block">
          <h2>Your private tables</h2>
          {myPrivateTables === null ? (
            <p className="empty-state">Loading...</p>
          ) : myPrivateTables.length === 0 ? (
            <p className="empty-state">You haven't joined any private tables yet.</p>
          ) : (
            <ul className="table-list">
              {myPrivateTables.map((t) => {
                const code = t.kind.__kind__ === "Private" ? t.kind.Private.code : undefined;
                return (
                  <li key={t.id.toString()}>
                    <button className="table-row" onClick={() => onOpenTable(t.id, code)}>
                      <span className="table-row-badge private">Private</span>
                      <span className="table-row-name">
                        <strong>{t.name}</strong>
                        <span className="table-row-stakes">
                          {formatPiko(t.smallBlind)}/{formatPiko(t.bigBlind)} &middot; {formatPiko(t.buyIn)} PIKO buy-in
                        </span>
                      </span>
                      <span className="table-row-seats">{t.seatsTaken.toString()}/{TABLE_SEATS}</span>
                      <span className="table-row-phase">{phaseTag(t.phase)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="block">
        <h2>Join a private table</h2>
        <div className="join-form">
          <span className="field-label">Invite link or table number</span>
          <div className="form-row">
            <div className="field">
              <input
                className="input"
                placeholder="https://... or a table number"
                value={inviteInput}
                onChange={(e) => setInviteInput(e.target.value)}
              />
            </div>
            <button className="button" onClick={handleJoinInvite}>
              Open
            </button>
          </div>
          {inviteError && <p className="error-text">{inviteError}</p>}
        </div>
      </section>

      <section className="block">
        <h2>Create a private table</h2>
        {createResult ? (
          <div className="private-result">
            <p>Table created. Share this link with friends:</p>
            <div className="invite-link-row">
              <span className="invite-link">{`${frontendUrl}?table=${createResult.id.toString()}&code=${createResult.code}`}</span>
              <button className="button small" onClick={handleCopyCreated}>
                {copiedCreated ? "Copied!" : "Copy"}
              </button>
            </div>
            <div className="qr-box">
              <QrCode
                value={`${frontendUrl}?table=${createResult.id.toString()}&code=${createResult.code}`}
                size={160}
                label="Table invite QR code"
              />
            </div>
            <button className="button button-cta" onClick={() => onOpenTable(createResult.id, createResult.code)}>
              Enter table
            </button>
          </div>
        ) : (
          <div className="create-form">
            <span className="field-label">Table name</span>
            <input
              className="input"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="Friday night game"
              maxLength={32}
            />
            <span className="field-label">Buy-in (PIKO)</span>
            <input
              className="input"
              value={createBuyIn}
              onChange={(e) => setCreateBuyIn(e.target.value)}
              placeholder="1000"
            />
            <button className="button" style={{ marginTop: 8 }} disabled={creating} onClick={handleCreate}>
              {creating ? "Creating..." : "Create table"}
            </button>
            {createError && <p className="error-text">{createError}</p>}
          </div>
        )}
      </section>
    </>
  );
}
