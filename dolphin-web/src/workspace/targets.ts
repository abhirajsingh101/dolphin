/** A session on a machine. `machine` is the machine's id (`local` for this
    computer); targets saved before it existed find theirs by project. */
export type Target = { projectId: string; projectName: string; sessionName: string; machine?: string };

/** The identity the workspace stores windows, pins and tabs under. */
export const targetKey = (target: Target): string => JSON.stringify([target.projectId, target.sessionName]);
