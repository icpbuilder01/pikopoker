import { useEffect, useRef, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { getPikopokerActor } from "../lib/actors";
import { shortPrincipal } from "../lib/format";
import type { ChatMessage } from "../bindings/pikopoker/pikopoker";

interface TableChatProps {
  tableId: bigint;
  identity: Identity | null;
  myPrincipalText: string | null;
}

const CHAT_POLL_MS = 2500;
const CHAT_MAX_LEN = 240;

// 2026-09-15: per-table chat, requested by the dev. Deliberately only
// polls (and only renders its message list) while `open` -- closed by
// default on both desktop and mobile -- so a table nobody has chat open
// on costs nothing beyond the one-time mount, matching the "save cycles"
// ask directly (this is the frontend half of the same reasoning behind
// the backend's lazy 24h expiry, see tableChats' own comment in main.mo).
export function TableChat({ tableId, identity, myPrincipalText }: TableChatProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    async function poll() {
      try {
        const msgs = await getPikopokerActor().getTableChat(tableId);
        if (!cancelled) setMessages(msgs);
      } catch (err) {
        console.error("getTableChat failed", err);
      }
    }
    poll();
    const id = setInterval(poll, CHAT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open, tableId]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, open]);

  async function handleSend() {
    if (!identity) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    setError(null);
    try {
      const result = await getPikopokerActor(identity).sendTableChat(tableId, trimmed);
      if (result.__kind__ === "Err") {
        setError("Message not sent -- try again.");
      } else {
        setText("");
        const msgs = await getPikopokerActor().getTableChat(tableId);
        setMessages(msgs);
      }
    } catch (err) {
      console.error("sendTableChat failed", err);
      setError("Message not sent -- try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={`table-chat${open ? " open" : ""}`}>
      <button
        type="button"
        className="table-chat-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close table chat" : "Open table chat"}
        aria-expanded={open}
      >
        {open ? "✕" : "💬"}
      </button>
      {open && (
        <div className="table-chat-panel">
          <div className="table-chat-messages" ref={listRef}>
            {messages.length === 0 ? (
              <p className="empty-state small">No messages yet -- say hi. Messages disappear after 24h.</p>
            ) : (
              messages.map((m, i) => {
                const senderText = m.sender.toText();
                const mine = myPrincipalText !== null && senderText === myPrincipalText;
                return (
                  <div className={`table-chat-message${mine ? " mine" : ""}`} key={`${senderText}-${m.timestamp.toString()}-${i}`}>
                    <span className="table-chat-sender">{mine ? "You" : shortPrincipal(senderText)}</span>
                    <span className="table-chat-text">{m.text}</span>
                  </div>
                );
              })
            )}
          </div>
          {identity ? (
            <div className="table-chat-input-row">
              <input
                className="input table-chat-input"
                value={text}
                maxLength={CHAT_MAX_LEN}
                placeholder="Say something..."
                disabled={sending}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSend();
                }}
              />
              <button className="button small" disabled={sending || !text.trim()} onClick={handleSend}>
                Send
              </button>
            </div>
          ) : (
            <p className="empty-state small">Log in to chat.</p>
          )}
          {error && <p className="error-text small">{error}</p>}
        </div>
      )}
    </div>
  );
}
