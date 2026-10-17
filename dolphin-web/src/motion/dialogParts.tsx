import { createContext, useContext, type HTMLAttributes, type ReactNode, type Ref } from 'react';

/* The pieces a dialog is built from, without Motion (design contract:
   "Motion vocabulary").

   Every dialog renders its scrim and panel through these parts. On their own
   they are plain divs, so the legacy board (App.tsx), which keeps its
   no-entrance contract and must not pull Motion into the initial bundle, gets
   exactly the markup it always had. The glass workspace provides the Motion
   parts (MotionDialog.tsx) through DialogPartsContext, and there the same
   dialogs fade their scrim, lift their panel, and animate out on close. */

export type DialogDivProps = HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> };

export type DialogParts = {
  /** Keeps a closing dialog rendered while it animates out. */
  Presence: (props: { children?: ReactNode }) => ReactNode;
  Scrim: (props: DialogDivProps) => ReactNode;
  Panel: (props: DialogDivProps) => ReactNode;
  /** False from the moment a dialog starts closing until it is gone. */
  usePresent: () => boolean;
};

export const plainDialogParts: DialogParts = {
  Presence: ({ children }) => children,
  Scrim: (props) => <div {...props} />,
  Panel: (props) => <div {...props} />,
  usePresent: () => true,
};

export const DialogPartsContext = createContext<DialogParts>(plainDialogParts);

export function useDialogParts(): DialogParts {
  return useContext(DialogPartsContext);
}

/** Whether this dialog is still open, rather than animating out. A closing
    dialog hands back the focus and the Escape key at once: the effects that
    own them list this as a dependency and stop when it turns false. The
    provider is fixed for a tree's lifetime, so the hook called here never
    changes between renders. */
export function useDialogPresent(): boolean {
  return useContext(DialogPartsContext).usePresent();
}
