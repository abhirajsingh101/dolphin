import type { TerminalClient } from '@dolphin-terminal/protocol';

import { api, type Api } from './api';

// The terminal protocol still declares session automation. Dolphin removed it,
// so every terminal mounts with `automation={false}` and these always refuse.
function automationRemoved(): Promise<never> {
  return Promise.reject(new Error('Session automation was removed from Dolphin.'));
}

const clients = new WeakMap<Api, TerminalClient>();

/**
 * Dolphin Tasks remains the provider of projects and dictation. The standalone
 * component knows only this terminal contract, here bound to one backend
 * (Dolphin Desktop: the machine the session runs on).
 */
export function terminalClientFor(backend: Api): TerminalClient {
  let client = clients.get(backend);
  if (client) return client;
  client = {
    fetchWorkspace(projectId, _signal) {
      return backend.fetchWorkspace(projectId);
    },
    createSession: backend.createTmuxSession,
    renameSession: backend.renameTmuxSession,
    closeSession: backend.closeTmuxSession,
    fetchSnapshot: backend.fetchTmuxSnapshot,
    resolvePaths: backend.resolveTerminalPaths,
    fileDownloadUrl: backend.workspaceFileDownloadUrl,
    streamUrl: backend.tmuxStreamUrl,
    uploadAttachment: backend.uploadTmuxAttachment,
    fetchAutomation: automationRemoved,
    updateAutomation: automationRemoved,
    cancelAutomation: automationRemoved,
    fetchAutomationDetails: automationRemoved,
    updateProjectBrief: automationRemoved,
    refreshAutomationSourceContext: automationRemoved,
    stopAllAutomation: automationRemoved,
  };
  clients.set(backend, client);
  return client;
}

export const dolphinTerminalClient: TerminalClient = terminalClientFor(api);
