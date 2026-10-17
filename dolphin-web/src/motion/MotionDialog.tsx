import { AnimatePresence, motion, useIsPresent, useReducedMotion, type HTMLMotionProps, type Variants } from 'motion/react';
import { useLayoutEffect, useState, type CSSProperties, type ReactNode, type Ref } from 'react';

import { DialogPartsContext, type DialogDivProps, type DialogParts } from './dialogParts';
import { dialogVariants, fadeVariants, menuAboveVariants, menuVariants, presence, scrimVariants } from './presets';

/* Overlays in motion (design contract: "Motion vocabulary"): the dialog parts
   the glass workspace provides, and the popover its menus drop from.

   Everything here follows one rule for leaving: the moment an overlay starts
   closing it is already gone as far as the user is concerned. It takes no
   pointer, keyboard or assistive-technology input (pointer-events: none and
   inert), a dialog stops being modal, and the dialog's own effects hand focus
   and Escape back (useDialogPresent). Only the picture lingers, for
   duration.panelOut. Arrivals never wait either: a dialog is focusable from
   its first frame, while it is still fading in. */

type Closing = { style?: CSSProperties; inert?: boolean; 'data-closing'?: true };

/** The props an overlay on its way out carries. */
export function closingProps(present: boolean, style?: CSSProperties): Closing {
  return present ? { style } : { style: { ...style, pointerEvents: 'none' }, inert: true, 'data-closing': true };
}

/** A closing overlay lets go of the focus in the same commit, before any
    effect hands it back to what opened the overlay, so a key pressed during
    the exit never lands in something already closed. */
export function useLetGo(present: boolean): void {
  useLayoutEffect(() => {
    if (present) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('[data-closing]')) active.blur();
  }, [present]);
}

/** For an overlay rendered into a portal: whether the portal should exist,
    which is while the overlay is open and until it has animated out (pass
    the callback to AnimatePresence's onExitComplete). A closed overlay keeps
    no portal, so a component that has never opened one renders none. */
export function useOverlayLayer(open: boolean): [boolean, () => void] {
  const [layer, setLayer] = useState(open);
  if (open && !layer) setLayer(true);
  return [open || layer, () => setLayer(false)];
}

/** Under reduced motion an overlay only fades. MotionConfig's "user" already
    skips transform animation, but an overlay's first frame would still be its
    `hidden` transform; with these variants there is no transform at all.
    The media query is read again on every render as well: Motion's own flag
    follows the query's change event, which not every host sends when the
    setting changes while the app is open (Electron under emulation does not). */
export function useCalm(variants: Variants): Variants {
  const flagged = useReducedMotion();
  const now = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  return flagged || now ? fadeVariants : variants;
}

const asMotion = (props: DialogDivProps) => props as HTMLMotionProps<'div'>;

function Presence({ children }: { children?: ReactNode }) {
  return <AnimatePresence>{children}</AnimatePresence>;
}

/** The dimmed layer: fades in, and out faster. */
function Scrim({ style, ...props }: DialogDivProps) {
  const present = useIsPresent();
  useLetGo(present);
  return <motion.div {...asMotion(props)} {...closingProps(present, style)} variants={scrimVariants} {...presence} />;
}

/** The panel: rises a few pixels and scales out of its scrim, with no overshoot. */
function Panel({ style, ...props }: DialogDivProps) {
  const present = useIsPresent();
  return (
    <motion.div
      {...asMotion(props)}
      style={style}
      aria-modal={present ? props['aria-modal'] : undefined}
      variants={useCalm(dialogVariants)}
      {...presence}
    />
  );
}

export const motionDialogParts: DialogParts = { Presence, Scrim, Panel, usePresent: useIsPresent };

/** Gives every dialog under it the Motion parts. */
export function MotionDialogs({ children }: { children: ReactNode }) {
  return <DialogPartsContext.Provider value={motionDialogParts}>{children}</DialogPartsContext.Provider>;
}

type PopoverProps = Omit<HTMLMotionProps<'div'>, 'style'> & {
  ref?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  /** Where the menu sits relative to the control that opened it. */
  side?: 'below' | 'above';
  /** Which edge it shares with that control: it grows from there. */
  align?: 'left' | 'right';
};

/** A menu or popover, inside AnimatePresence: it drops from its trigger
    (rises, when placed above it) and leaves faster than it came. */
export function MotionPopover({ side = 'below', align = 'right', style, ...props }: PopoverProps) {
  const present = useIsPresent();
  useLetGo(present);
  const origin = `${side === 'below' ? 'top' : 'bottom'} ${align}`;
  return (
    <motion.div
      {...props}
      {...closingProps(present, { ...style, transformOrigin: origin })}
      variants={useCalm(side === 'above' ? menuAboveVariants : menuVariants)}
      {...presence}
    />
  );
}
