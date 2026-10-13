import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { ArrowUp } from 'lucide-react';

import { useTabState } from '../GlassChatTabs';

/** `restore` puts a failed message back into an empty draft: into `tab` when
    given (the tab it was sent from), otherwise the tab in front. */
export type ComposerHandle = { focus(): void; setDraft(text: string): void; restore(text: string, tab?: string): void; clearIf(text: string): void };

/* The chat composer, with its own draft state: a keystroke renders this and
   nothing else. Drafts stay per chat tab, saved under dolphin.glass.chat-draft. */
const ChatComposer = forwardRef<ComposerHandle, { tabId: string; disabled: boolean; onSend: (text: string) => void }>(
  function ChatComposer({ tabId, disabled, onSend }, ref) {
    const [draft, setDraft, , setDraftFor] = useTabState(tabId, '', 'dolphin.glass.chat-draft');
    const input = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(ref, () => ({
      focus: () => input.current?.focus(),
      setDraft: (text) => { setDraft(text); input.current?.focus(); },
      restore: (text, tab) => setDraftFor(tab ?? tabId, (current) => current || text),
      clearIf: (text) => setDraft((current) => (current.trim() === text ? '' : current)),
    }));
    useEffect(() => {
      const element = input.current;
      if (!element) return;
      const fit = () => { element.style.height = 'auto'; element.style.height = `${Math.min(element.scrollHeight, 144)}px`; };
      fit();
      // Dragging the chat column rewraps the draft, so refit on width changes too.
      let width = element.clientWidth;
      const observer = new ResizeObserver(() => { if (element.clientWidth !== width) { width = element.clientWidth; fit(); } });
      observer.observe(element);
      return () => observer.disconnect();
    }, [draft]);
    const submit = () => {
      const text = draft.trim();
      if (!text || disabled) return;
      setDraft('');
      onSend(text);
    };
    return (
      <form className="glass-composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <textarea aria-label="Message Dolphin" placeholder="Ask Dolphin, or start something…" ref={input} rows={1} maxLength={4000}
          value={draft} onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
        <div>
          <button className="glass-send" aria-label="Send message" disabled={disabled || !draft.trim()}><ArrowUp size={19} /></button>
        </div>
      </form>
    );
  },
);
export default ChatComposer;
