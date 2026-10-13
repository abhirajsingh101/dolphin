/** One session's identity across machines: `machine|project|session`. */
export function terminalKey(machine: string | undefined, projectId: string, sessionName: string): string {
  return `${machine ?? 'local'}|${projectId}|${sessionName}`;
}
