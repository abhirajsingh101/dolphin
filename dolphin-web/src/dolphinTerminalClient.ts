import type { TerminalClient } from '@dolphin-terminal/protocol';

import {
  closeTmuxSession,
  createTmuxSession,
  fetchTmuxSnapshot,
  fetchWorkspace,
  renameTmuxSession,
  resolveTerminalPaths,
  tmuxStreamUrl,
  uploadTmuxAttachment,
  workspaceFileDownloadUrl,
} from './api';

// The terminal protocol still declares session automation. Dolphin removed it,
// so every terminal mounts with `automation={false}` and these always refuse.
function automationRemoved(): Promise<never> {
  return Promise.reject(new Error('Session automation was removed from Dolphin.'));
}

/**
 * Dolphin Tasks remains the provider of projects and dictation. The standalone
 * component knows only this terminal contract.
 */
export const dolphinTerminalClient: TerminalClient = {
  fetchWorkspace(projectId, _signal) {
    return fetchWorkspace(projectId);
  },
  createSession: createTmuxSession,
  renameSession: renameTmuxSession,
  closeSession: closeTmuxSession,
  fetchSnapshot: fetchTmuxSnapshot,
  resolvePaths: resolveTerminalPaths,
  fileDownloadUrl: workspaceFileDownloadUrl,
  streamUrl: tmuxStreamUrl,
  uploadAttachment: uploadTmuxAttachment,
  fetchAutomation: automationRemoved,
  updateAutomation: automationRemoved,
  cancelAutomation: automationRemoved,
  fetchAutomationDetails: automationRemoved,
  updateProjectBrief: automationRemoved,
  refreshAutomationSourceContext: automationRemoved,
  stopAllAutomation: automationRemoved,
};
