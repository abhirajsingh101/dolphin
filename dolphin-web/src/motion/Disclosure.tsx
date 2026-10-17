import { AnimatePresence, motion, useReducedMotion, type Variants } from 'motion/react';
import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { disclosureVariants, presence, settleTransition } from './presets';

/* A native <details>/<summary> whose body opens and closes with motion.

   The summary stays the native control: Enter and Space activate it, and
   screen readers announce it as expanded or collapsed from <details open>.
   Its click (which keyboard activation also dispatches) is taken over so the
   body can animate out before `open` is removed; opening sets `open` first
   and then grows the body. Opening from outside (setting `open` in code) is
   followed. A closed body is not rendered, so find in page cannot see it.
   Reopening halfway through a close reverses it from where it is. */

const instant: Variants = {
  hidden: { height: 0, opacity: 0, transition: { duration: 0 } },
  shown: { height: 'auto', opacity: 1, overflow: 'visible', transition: { duration: 0 } },
};

export default function Disclosure({ summary, children, defaultOpen = false, className, bodyClassName, layout = false }: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  bodyClassName?: string;
  /** Glide to a new position when the list around it changes. */
  layout?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // The <details open> attribute: true from the moment it opens until its body has closed.
  const [attribute, setAttribute] = useState(defaultOpen);
  const openRef = useRef(open);
  openRef.current = open;
  const reduce = useReducedMotion();
  const toggle = (event: MouseEvent) => {
    event.preventDefault();
    if (!open) setAttribute(true);
    setOpen(!open);
  };
  return <motion.details className={className} open={attribute} data-state={open ? 'open' : 'closed'}
    layout={layout ? 'position' : undefined} transition={layout ? settleTransition : undefined}
    onToggle={(event) => { if (event.currentTarget.open && !openRef.current) { setAttribute(true); setOpen(true); } }}>
    <summary onClick={toggle}>{summary}</summary>
    <AnimatePresence initial={false} onExitComplete={() => { if (!openRef.current) setAttribute(false); }}>
      {open && <motion.div key="body" className={bodyClassName} data-disclosure-body=""
        variants={reduce ? instant : disclosureVariants} {...presence}>
        {children}
      </motion.div>}
    </AnimatePresence>
  </motion.details>;
}
