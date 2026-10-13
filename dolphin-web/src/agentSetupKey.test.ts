import { describe, expect, it } from 'vitest';
import { agentSetupDismissKey } from './agentSetupKey';

describe('agent setup dismissal', () => {
  it('is remembered per machine, never per relay port', () => {
    expect(agentSetupDismissKey('local')).toBe('dolphin.desktop.agent-setup-dismissed:local');
    expect(agentSetupDismissKey('gpu-box')).toBe('dolphin.desktop.agent-setup-dismissed:gpu-box');
    expect(agentSetupDismissKey('local')).not.toMatch(/127\.0\.0\.1|:\d{4,5}$/);
  });
});
