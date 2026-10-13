import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';

import { request } from '../api';
import DolphinIcon from '../DolphinIcon';
import MarkdownReply from './MarkdownReply';
import type { ToolActivity } from './chatTypes';

/* A turn in progress: its tool activity and the reply as it is written. It
   polls on its own (150ms for text, 1.5s for activity), so only it re-renders. */
export default function LiveReply({ thread, running, lastRole, renderActivity, onGrow }: {
  thread: string;
  running: boolean;
  lastRole: 'user' | 'assistant' | undefined;
  renderActivity: (items: ToolActivity[]) => ReactNode;
  onGrow: () => void;
}) {
  const [text, setText] = useState('');
  const [activity, setActivity] = useState<ToolActivity[]>([]);
  useEffect(() => {
    setText('');
    if (!thread || !running) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const progress = await request<{ turn_id?: string; text?: string }>(`/api/dolphin/threads/${encodeURIComponent(thread)}/progress`);
        if (alive && progress.turn_id && typeof progress.text === 'string') setText(progress.text);
      } catch { /* Saved conversation polling still recovers the final reply. */ }
      if (alive) timer = setTimeout(poll, 150);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [thread, running]);
  useEffect(() => {
    setActivity([]);
    if (!thread || !running) return;
    let alive = true;
    const poll = async () => {
      try {
        const items = await request<ToolActivity[]>(`/api/dolphin/threads/${encodeURIComponent(thread)}/activity`);
        if (alive && Array.isArray(items)) setActivity(items);
      } catch { /* The final response still carries durable receipts. */ }
    };
    void poll();
    const timer = setInterval(poll, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [thread, running]);
  useLayoutEffect(() => { onGrow(); }, [text, activity.length, onGrow]);
  if (!running) return null;
  return (
    <>
      {renderActivity(activity)}
      {text && lastRole !== 'assistant' && (
        <div className="glass-message assistant glass-streaming" aria-label="Dolphin response in progress" aria-busy="true">
          <div className="glass-reply-mark"><span className="dolphin-mark"><DolphinIcon /></span></div>
          <div><MarkdownReply text={text} /></div>
        </div>
      )}
      <p role="status" className="glass-thinking">{text ? 'Dolphin is writing…' : 'Dolphin is working…'}</p>
    </>
  );
}
