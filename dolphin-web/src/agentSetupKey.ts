/** Where "Not Now" on the agent-setup line is remembered: per machine, never
    per address (this computer's relay port changes at every launch). */
export const agentSetupDismissKey = (machine: string) => `dolphin.desktop.agent-setup-dismissed:${machine}`;
