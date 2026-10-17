/* Dolphin's motion vocabulary (design contract: "Motion vocabulary").

   Four kinds of movement, one set of numbers, shared by every Motion
   component so nothing invents its own timing:

   - control: immediate feedback on a press, 100-160ms.
   - panel: dialogs, menus, toasts and previews. Anchored, short travel,
     180-260ms in and faster out.
   - navigation: shared selection indicators (tabs, segmented switches).
   - content: new things arriving in a list and the rest settling, 220-320ms.

   Springs have no overshoot to speak of (damping near critical), so they
   settle like an ease-out but keep velocity when the user reverses a
   movement halfway. The tween curve is the CSS --ease token. Every Motion
   tree sits under <MotionConfig reducedMotion="user">, which drops transform
   and layout animation for reduced motion and keeps the opacity fades. */

import type { Transition, Variants } from 'motion/react';

/** The CSS --ease token, cubic-bezier(0.16, 1, 0.3, 1). */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
/** Exits accelerate away instead of settling. */
export const EASE_IN = [0.4, 0, 1, 1] as const;

export const spring = {
  /** Presses and small toggles. */
  control: { type: 'spring', stiffness: 700, damping: 45, mass: 0.6 },
  /** Dialogs, menus, toasts settling into place. */
  panel: { type: 'spring', stiffness: 520, damping: 42, mass: 0.8 },
  /** Shared selection indicators gliding between tabs. */
  navigation: { type: 'spring', stiffness: 560, damping: 44, mass: 0.7 },
  /** List items making room and settling. */
  content: { type: 'spring', stiffness: 380, damping: 38, mass: 0.9 },
} satisfies Record<string, Transition>;

export const duration = {
  control: 0.12,
  panelIn: 0.22,
  panelOut: 0.14,
  content: 0.26,
} as const;

const fade = (seconds: number, ease: readonly number[] = EASE_OUT): Transition => ({ duration: seconds, ease: ease as Transition['ease'] });

/** The dimmed layer behind a dialog. */
export const scrimVariants: Variants = {
  hidden: { opacity: 0, transition: fade(duration.panelOut, EASE_IN) },
  shown: { opacity: 1, transition: fade(duration.panelIn * 0.8) },
};

/** A centred dialog panel: rises a few pixels and scales out of its scrim. */
export const dialogVariants: Variants = {
  hidden: { opacity: 0, y: 8, scale: 0.97, transition: { ...fade(duration.panelOut, EASE_IN) } },
  shown: { opacity: 1, y: 0, scale: 1, transition: { ...spring.panel, opacity: fade(duration.panelIn) } },
};

/** A menu or popover dropping from the control that opened it. Set the
    element's transform-origin to the trigger's side. */
export const menuVariants: Variants = {
  hidden: { opacity: 0, y: -4, scale: 0.97, transition: fade(duration.panelOut * 0.85, EASE_IN) },
  shown: { opacity: 1, y: 0, scale: 1, transition: { ...spring.panel, opacity: fade(duration.panelIn * 0.8) } },
};

/** A toast arriving from the edge it is stacked against, and leaving faster. */
export const toastVariants: Variants = {
  hidden: { opacity: 0, x: 16, scale: 0.98, transition: fade(duration.panelOut, EASE_IN) },
  shown: { opacity: 1, x: 0, scale: 1, transition: { ...spring.panel, opacity: fade(duration.panelIn) } },
};

/** A short fade for previews and content swaps; no travel. */
export const fadeVariants: Variants = {
  hidden: { opacity: 0, transition: fade(duration.panelOut, EASE_IN) },
  shown: { opacity: 1, transition: fade(duration.panelIn * 0.7) },
};

/** Props for one AnimatePresence child using a variants pair above. */
export const presence = { initial: 'hidden', animate: 'shown', exit: 'hidden' } as const;

/* In-surface navigation and content (design contract: "In-surface motion").
   Only what arrives or leaves while the person watches uses these; what a
   surface restores on load, on a tab switch or from a poll appears in place. */

/** A tab added to or closed from a strip; its neighbours glide with
    `layout="position"` on spring.control. */
export const tabVariants: Variants = {
  hidden: { opacity: 0, y: 3, transition: fade(duration.panelOut, EASE_IN) },
  shown: { opacity: 1, y: 0, transition: { y: spring.control, opacity: fade(duration.control) } },
};

/** A panel replacing another in place (Projects/Tasks). It has no exit: the
    old panel goes at once, so switching back and forth never queues
    animations or shows both. */
export const swapVariants: Variants = {
  hidden: { opacity: 0, y: 4 },
  shown: { opacity: 1, y: 0, transition: { y: spring.content, opacity: fade(duration.content * 0.7) } },
};

/** A chat message received or sent while its conversation is on screen. */
export const arrivalVariants: Variants = {
  hidden: { opacity: 0, y: 6 },
  shown: { opacity: 1, y: 0, transition: { y: spring.content, opacity: fade(duration.content * 0.7) } },
};

/** A disclosure's body opening and closing. Height is animated here and
    nowhere else: these bodies hold rows and text, never a terminal. The body
    clips only while it moves, so focus rings inside it are never cut off. */
export const disclosureVariants: Variants = {
  hidden: { height: 0, opacity: 0, overflow: 'hidden', transition: { height: fade(duration.content * 0.8), opacity: fade(duration.panelOut, EASE_IN) } },
  shown: { height: 'auto', opacity: 1, overflow: 'hidden', transitionEnd: { overflow: 'visible' }, transition: { height: fade(duration.content), opacity: fade(duration.content * 0.8) } },
};

/** A row checked off or deleted: it fades a little sideways while the rows
    below move up (`layout="position"` with settleTransition). */
export const rowVariants: Variants = {
  hidden: { opacity: 0, x: 8, transition: { opacity: fade(duration.content * 0.8, EASE_IN), x: fade(duration.content, EASE_IN) } },
  shown: { opacity: 1, x: 0, transition: { opacity: fade(duration.control), x: spring.content } },
};

/** A session window opening or closing. Opacity and movement have separate
    transitions, and size is never animated: a terminal fits itself to every
    size it is given and would resize tmux on each frame. */
export const windowVariants: Variants = {
  hidden: { opacity: 0, x: 16, transition: { opacity: fade(duration.panelOut, EASE_IN), x: fade(duration.panelOut, EASE_IN) } },
  shown: { opacity: 1, x: 0, transition: { opacity: fade(duration.panelIn), x: spring.content } },
};

/** What neighbours do while something arrives or leaves: they move, position
    only, on spring.content. */
export const settleTransition: Transition = { layout: spring.content };

/** The shared selection indicator under a tab strip's selected tab. */
export const indicatorTransition: Transition = { layout: spring.navigation };
/** menuVariants for a menu placed above its trigger: it rises into place
    instead of dropping. Pair it with a bottom transform-origin. */
export const menuAboveVariants: Variants = {
  hidden: { ...(menuVariants.hidden as object), y: 4 },
  shown: menuVariants.shown,
};

/** The rest of a stack (toasts) closing the gap a leaving item opened. */
export const settle: Transition = spring.panel;
