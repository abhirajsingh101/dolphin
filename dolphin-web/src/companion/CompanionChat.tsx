import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { useApi } from '../apiContext';
import MarkdownReply from '../workspace/MarkdownReply';
import type { Message } from '../workspace/chatTypes';

/* The conversation with a project's companion, at the foot of its Tasks tab.
   One thread per project, kept by the backend. The companion's replies can
   carry suggestions; the Tasks tab reads them from the messages. */

let consumedFocus = 0;

export default function CompanionChat({ projectId, projectName, focusSignal, onMessages, onBusy }: {
  projectId: string;
  projectName: string;
  /** Changes when the character is clicked; the composer takes focus. */
  focusSignal: number;
  onMessages: (messages: Message[]) => void;
  /** Whether a reply is being written; the character thinks meanwhile. */
  onBusy?: (busy: boolean) => void;
}) {
  const { openCompanion, sendCompanionTurn, fetchCompanionProgress } = useApi();
  const [thread, setThread] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [live, setLive] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const report = useRef(onMessages);
  report.current = onMessages;

  async function load() {
    const raw = await openCompanion(projectId);
    // An older backend has no companion; the chat stays closed rather than break the tab.
    if (!raw || typeof raw.id !== 'string') throw new Error('No companion here.');
    const detail = { ...raw, messages: Array.isArray(raw.messages) ? raw.messages : [], pending_idempotency_keys: Array.isArray(raw.pending_idempotency_keys) ? raw.pending_idempotency_keys : [] };
    setThread(detail.id);
    setMessages(detail.messages);
    setPending(detail.pending_idempotency_keys.length > 0);
    report.current(detail.messages);
    return detail;
  }
  useEffect(() => {
    let alive = true;
    setThread(null); setMessages([]); setError('');
    load().catch(() => { if (alive) setError(`Could not open ${projectName}'s chat.`); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // A reply started elsewhere (another window, a reload mid-turn) finishes on its own.
  useEffect(() => {
    if (!pending || sending) return;
    const timer = window.setInterval(() => { void load().catch(() => undefined); }, 2000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, sending]);

  const running = !!sending || pending;
  useEffect(() => { onBusy?.(running); }, [running, onBusy]);
  useEffect(() => {
    setLive('');
    if (!thread || !running) return;
    let alive = true;
    let timer: number;
    const poll = async () => {
      try {
        const progress = await fetchCompanionProgress(thread);
        if (alive && progress.turn_id && typeof progress.text === 'string') setLive(progress.text);
      } catch { /* The saved reply still arrives. */ }
      if (alive) timer = window.setTimeout(poll, 300);
    };
    void poll();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [thread, running, fetchCompanionProgress]);

  // Each click on the character focuses the composer once; a remount later
  // (switching projects, reopening the tab) leaves focus where it is.
  useEffect(() => {
    if (focusSignal > consumedFocus) { consumedFocus = focusSignal; input.current?.focus(); }
  }, [focusSignal]);
  useLayoutEffect(() => {
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length, sending, live]);

  async function send() {
    const text = draft.trim();
    if (!text || !thread || running) return;
    setDraft(''); setError(''); setSending(text);
    try {
      const result = await sendCompanionTurn(thread, text, crypto.randomUUID());
      const detail = await load();
      if (result.status !== 'completed' && result.status !== 'in_progress' && !detail.pending_idempotency_keys.length) setError(result.display_text || 'No reply this time.');
    } catch {
      setDraft(text);
      setError('Could not reach the chat. Your message is back in the box.');
    } finally {
      setSending(null);
    }
  }

  const shown = sending ? [...messages, { id: 'sending', role: 'user' as const, text: sending }] : messages;
  return <section className="dt-companion-chat" aria-label={`Chat with ${projectName}'s companion`}>
    {shown.length > 0 && <div ref={list} className="dt-companion-messages">
      {shown.map((m) => <div key={m.id} className={`dt-companion-message ${m.role}`}>
        {m.role === 'assistant' ? <MarkdownReply text={m.text} /> : m.text}
      </div>)}
      {running && <div className="dt-companion-message assistant" aria-busy="true">
        {live ? <MarkdownReply text={live} /> : <span className="dt-companion-typing" aria-label="Thinking"><i /><i /><i /></span>}
      </div>}
    </div>}
    {error && <p role="alert" className="dt-companion-error">{error}</p>}
    <form onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <textarea
        ref={input}
        rows={1}
        value={draft}
        placeholder={`Ask about ${projectName}…`}
        aria-label={`Message ${projectName}'s companion`}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
        }}
      />
      <button type="submit" aria-label="Send" disabled={!draft.trim() || !thread || running}><ArrowUp size={15} /></button>
    </form>
  </section>;
}
