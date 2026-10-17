import { useEffect, useRef, useState, type RefObject } from 'react';
import { DolphinApiError } from './api';
import { useDialogPresent } from './motion/dialogParts';

/* What the workflow panels (Ports, Usage, History, Diff, Import) share as
   modals: focus moves in on open and back to what opened them on close, and
   Escape closes the topmost one wherever the focus is, once. */

let lastOpener: HTMLElement | null = null;
let tracking = false;

/** Remembers what the user last focused outside a dialog, so a panel opened
 * from a menu item (gone by the time the panel renders) returns to the menu's
 * button. Called once from the workspace, which loads before any panel. */
export function trackPanelOpeners(): void {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  document.addEventListener('focusin', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest('[role="dialog"]')) return;
    if (target.closest('[role="menu"]')) {
      const trigger = document.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-expanded="true"]');
      if (trigger) lastOpener = trigger;
      return;
    }
    lastOpener = target;
  }, true);
}

function currentOpener(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && !active.closest('[role="menu"], [role="dialog"]')) return active;
  return lastOpener;
}

/** Open panels, newest last: only the newest answers Escape. */
const open: symbol[] = [];

export function useModalPanel(panel: RefObject<HTMLElement | null>, onClose: () => void, options: {
  /** Where focus goes on open; the panel itself without it. */
  focus?: RefObject<HTMLElement | null>;
  /** True while something inside the panel owns Escape (an open comment box). */
  holdEscape?: () => boolean;
} = {}): void {
  const [opener] = useState(currentOpener);
  const close = useRef(onClose);
  close.current = onClose;
  const hold = useRef(options.holdEscape);
  hold.current = options.holdEscape;
  const focusTarget = options.focus;
  // A panel animating out (glass workspace) gives Escape and the focus back
  // as soon as it starts closing, not when it finally unmounts.
  const present = useDialogPresent();
  useEffect(() => {
    if (!present) return;
    const id = Symbol('panel');
    open.push(id);
    (focusTarget?.current ?? panel.current)?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || open[open.length - 1] !== id || hold.current?.()) return;
      event.preventDefault();
      close.current();
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('keydown', escape);
      open.splice(open.indexOf(id), 1);
      // Only when the focus went down with the panel: never pull it away from
      // something the user moved to meanwhile (a session a Resume opened).
      // A closing panel is still in the document, so focus inside it counts as gone.
      const active = document.activeElement;
      if (opener?.isConnected && (!active || active === document.body || panel.current?.contains(active))) opener.focus({ preventScroll: true });
    };
  }, [present]);
}

const HELPER_NEEDED = 'This needs the Dolphin helper on that machine.';

/** A panel's error line. A 404 with no detail of its own (a helper too old to
 * have the endpoint, or a server not in helper mode) names the helper instead. */
export function panelError(reason: unknown): string {
  if (reason instanceof DolphinApiError && reason.status === 404
    && /^(404 )?Not Found$|^Only available in Dolphin Desktop$/.test(reason.message)) return HELPER_NEEDED;
  return reason instanceof Error ? reason.message : String(reason);
}
