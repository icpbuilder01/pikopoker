import { useEffect, useRef, useState } from "react";
import type { Identity } from "@icp-sdk/core/agent";
import { getPikopokerActor } from "../lib/actors";
import { shortPrincipal } from "../lib/format";
import type { ChatMessage } from "../bindings/pikopoker/pikopoker";

interface TableChatProps {
  tableId: bigint;
  identity: Identity | null;
  myPrincipalText: string | null;
  // 2026-09-15: the private table's own invite code, so getTableChat/
  // sendTableChat can prove entitlement to a private table's chat the
  // same way getTableView now does -- see canViewTable's own comment in
  // main.mo for the real leak this (and the matching getTableView fix)
  // closes. undefined/absent for a public table, harmless either way.
  privateCode?: string;
}

const CHAT_POLL_MS = 2500;
const CHAT_IDLE_POLL_MS = 15000;
const CHAT_MAX_LEN = 240;

// 2026-09-15: per-table chat, requested by the dev. Only renders its
// message list while `open` -- closed by default on both desktop and
// mobile. Originally didn't poll at ALL while closed (matching the "save
// cycles" ask directly, same reasoning as the backend's lazy 24h expiry,
// see tableChats' own comment in main.mo) -- but the dev then asked for
// an unread-message dot on the closed toggle, which needs SOME way to
// notice new messages while closed. Compromise: still poll while closed,
// just much less often (15s vs 2.5s open) -- a real reduction from
// constant fast polling, just not the original zero.
export function TableChat({ tableId, identity, myPrincipalText, privateCode }: TableChatProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasUnread, setHasUnread] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Latest message timestamp the viewer has actually seen (panel open at
  // the time it arrived) -- a message newer than this while closed is
  // what lights up the dot. Not persisted (per-mount only, same lifetime
  // as the rest of this component's state) -- reopening the table later
  // just treats whatever's already there as unseen again, which is fine,
  // the dot is a "something happened while you weren't looking" nudge,
  // not a durable read-receipt system.
  const lastSeenTimestampRef = useRef<bigint>(0n);
  // The very first poll after mount establishes the baseline (whatever's
  // already in the table's chat history counts as "seen", not a pile of
  // unread from before this viewer ever loaded the page) -- only messages
  // that arrive in a LATER poll, while closed, actually light the dot.
  const hasPolledOnceRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const msgs = await getPikopokerActor().getTableChat(tableId, privateCode ?? null);
        if (cancelled) return;
        setMessages(msgs);
        const latest = msgs.length > 0 ? msgs[msgs.length - 1].timestamp : 0n;
        if (open || !hasPolledOnceRef.current) {
          lastSeenTimestampRef.current = latest;
          setHasUnread(false);
        } else {
          setHasUnread(latest > lastSeenTimestampRef.current);
        }
        hasPolledOnceRef.current = true;
      } catch (err) {
        console.error("getTableChat failed", err);
      }
    }
    poll();
    const id = setInterval(poll, open ? CHAT_POLL_MS : CHAT_IDLE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open, tableId, privateCode]);

  // Only follow new messages if the viewer is already at (or near) the
  // bottom -- otherwise scrolling up to read older ones would get yanked
  // back down on every poll.
  const stickToBottomRef = useRef(true);
  useEffect(() => {
    if (!listRef.current) return;
    if (stickToBottomRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, open]);

  async function handleSend() {
    if (!identity) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    setError(null);
    try {
      const result = await getPikopokerActor(identity).sendTableChat(tableId, trimmed, privateCode ?? null);
      if (result.__kind__ === "Err") {
        setError("Message not sent -- try again.");
      } else {
        setText("");
        stickToBottomRef.current = true;
        const msgs = await getPikopokerActor().getTableChat(tableId, privateCode ?? null);
        setMessages(msgs);
        if (msgs.length > 0) lastSeenTimestampRef.current = msgs[msgs.length - 1].timestamp;
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
        onClick={() => {
          stickToBottomRef.current = true;
          setOpen((v) => !v);
        }}
        aria-label={open ? "Close table chat" : hasUnread ? "Open table chat -- unread messages" : "Open table chat"}
        aria-expanded={open}
      >
        {open ? "✕" : "💬"}
        {!open && hasUnread && <span className="table-chat-unread-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="table-chat-panel">
          <div
            className="table-chat-messages"
            ref={listRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
          >
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
