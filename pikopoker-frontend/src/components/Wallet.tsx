import { useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getLedgerActor } from "../lib/actors";
import { formatPiko, parseAmount, shortPrincipal } from "../lib/format";
import { Modal } from "./Modal";
import { QrCode } from "./QrCode";
import { ChipAmount } from "./ChipAmount";

interface WalletProps {
  identity: Identity;
  balance: bigint | null;
  onClose: () => void;
  onBalanceChange: () => void;
}

type Tab = "send" | "receive";

export function Wallet({ identity, balance, onClose, onBalanceChange }: WalletProps) {
  const [tab, setTab] = useState<Tab>("send");
  const [recipientInput, setRecipientInput] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const principalText = identity.getPrincipal().toText();

  let recipient: Principal | null = null;
  let recipientError: string | null = null;
  const trimmedRecipient = recipientInput.trim();
  if (trimmedRecipient.length > 0) {
    try {
      recipient = Principal.fromText(trimmedRecipient);
    } catch {
      recipientError = "That doesn't look like a valid principal.";
    }
  }

  const amount = parseAmount(amountInput);

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    if (!recipient) {
      setStatus("Enter a valid recipient principal.");
      return;
    }
    if (amount === null || amount <= 0n) {
      setStatus("Enter a valid amount.");
      return;
    }
    setSending(true);
    setStatus(null);
    try {
      const ledger = getLedgerActor(identity);
      const result = await ledger.icrc1_transfer({ to: { owner: recipient }, amount });
      if (result.__kind__ === "Ok") {
        setStatus(`Sent ${formatPiko(amount)} PIKO to ${shortPrincipal(recipient.toText())}.`);
        setRecipientInput("");
        setAmountInput("");
        onBalanceChange();
      } else {
        setStatus(`Failed: ${JSON.stringify(result.Err)}`);
      }
    } catch (err) {
      console.error("Send failed", err);
      setStatus("Send failed -- try again.");
    } finally {
      setSending(false);
    }
  }

  async function handleCopyPrincipal() {
    try {
      await navigator.clipboard.writeText(principalText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Copy failed", err);
    }
  }

  return (
    <Modal title="Your wallet" onClose={onClose}>
      <div className="wallet-modal-balance">
        <span className="wallet-modal-balance-label">Balance</span>
        <span className="wallet-modal-balance-amount">
          {balance !== null ? <ChipAmount amount={balance} unit="PIKO" size={16} /> : "..."}
        </span>
      </div>

      <div className="pay-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "send"}
          className={`pay-tab ${tab === "send" ? "active" : ""}`}
          onClick={() => setTab("send")}
        >
          Send
        </button>
        <button
          role="tab"
          aria-selected={tab === "receive"}
          className={`pay-tab ${tab === "receive" ? "active" : ""}`}
          onClick={() => setTab("receive")}
        >
          Receive
        </button>
      </div>

      {tab === "send" ? (
        <form className="pay-panel" onSubmit={handleSend}>
          <span className="field-label">To (principal)</span>
          <input
            className="input"
            placeholder="Recipient principal"
            value={recipientInput}
            onChange={(e) => setRecipientInput(e.target.value)}
          />
          {recipientError && <p className="error-text">{recipientError}</p>}

          <span className="field-label">Amount (PIKO)</span>
          <input
            className="input"
            placeholder="0.00"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            inputMode="decimal"
          />

          <button type="submit" className="button button-cta" style={{ marginTop: 10 }} disabled={sending}>
            {sending ? "Sending..." : "Send PIKO"}
          </button>
          {status && <p className="wallet-status">{status}</p>}
          <p className="wallet-hint">
            Transfers go straight to the recipient's wallet on PIKO's own ICRC-1 ledger -- this app
            never holds your funds outside of an active table buy-in. Standard ledger fee applies.
          </p>
        </form>
      ) : (
        <div className="pay-panel">
          <div className="qr-box">
            <QrCode value={principalText} size={200} />
          </div>
          <div className="wallet-address-row">
            <code className="wallet-address">{principalText}</code>
            <button type="button" className="button secondary small" onClick={handleCopyPrincipal}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="wallet-hint">
            Share this principal (or the QR code) with anyone sending you PIKO -- from PikoPay,
            an exchange, or another wallet. It's just an address, nothing here can move funds on
            its own.
          </p>
        </div>
      )}
    </Modal>
  );
}
