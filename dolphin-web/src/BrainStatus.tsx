import { useEffect, useRef, useState } from 'react';
import { Brain } from 'lucide-react';
import { request } from './api';
import './composerNotice.css';

/* Dolphin's memory (a GBrain on this machine) sets itself up when the helper
   starts. This line shows that setup while it runs, says once when memory is
   ready, and offers a retry if setup failed. It shows nothing otherwise. */

type BrainState = { state: 'off' | 'missing' | 'installing' | 'ready' | 'failed'; step?: string; error?: string };

export default function BrainStatus() {
  const [brain, setBrain] = useState<BrainState | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const sawSetup = useRef(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await request<BrainState>('/api/brain');
        if (stopped) return;
        if (next.state === 'installing') sawSetup.current = true;
        setBrain(next);
        if (next.state === 'installing' || next.state === 'missing') timer = setTimeout(poll, 2000);
      } catch {
        if (!stopped) setBrain(null);
      }
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, []);

  const retry = async () => {
    try {
      setBrain(await request<BrainState>('/api/brain/setup', { method: 'POST' }));
      sawSetup.current = true;
      const wait = async () => {
        const next = await request<BrainState>('/api/brain');
        setBrain(next);
        if (next.state === 'installing') setTimeout(() => void wait(), 2000);
      };
      setTimeout(() => void wait(), 2000);
    } catch (error) {
      setBrain({ state: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  };

  if (!brain || dismissed) return null;
  if (brain.state === 'ready' && !sawSetup.current) return null;
  if (!['missing', 'installing', 'ready', 'failed'].includes(brain.state)) return null;

  return (
    <section className="signals-tray brain-status" aria-label="Memory">
      <div className="agent-hooks-row">
        <Brain size={15} aria-hidden="true" />
        {brain.state === 'installing' || brain.state === 'missing' ? (
          <span role="status">Setting up Dolphin’s memory… {brain.step ?? ''}</span>
        ) : brain.state === 'ready' ? (
          <>
            <span role="status">Memory is ready. Ask Dolphin to remember something, and it will recall it later.</span>
            <div className="signals-actions">
              <button type="button" onClick={() => setDismissed(true)}>Got It</button>
            </div>
          </>
        ) : (
          <>
            <span role="alert">Memory setup failed: {brain.error}</span>
            <div className="signals-actions">
              <button type="button" className="signals-primary" onClick={() => void retry()}>Retry</button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
