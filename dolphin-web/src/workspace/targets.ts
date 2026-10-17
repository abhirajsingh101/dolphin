/** A session on a machine. `machine` is the machine's id (`local` for this
    computer); targets saved before it existed find theirs by project. */
export type Target = { projectId: string; projectName: string; sessionName: string; machine?: string };

/** The identity the workspace stores windows, pins and tabs under. */
export const targetKey = (target: Target): string => JSON.stringify([target.projectId, target.sessionName]);

/** What a session is called on screen: a plain terminal (no tmux), named
    `term:<n>` by the helper, reads "Terminal <n>"; a tmux session, its name. */
export const sessionLabel = (name: string): string => (name.startsWith('term:') ? `Terminal ${name.slice(5)}` : name);
export const isPlainTerminal = (name: string): boolean => name.startsWith('term:');
