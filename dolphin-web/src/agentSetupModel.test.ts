import { describe, expect, it } from 'vitest';
import { agentSetupDismissKey } from './agentSetupKey';
import { dismissKey, doneMessage, offerFor } from './agentSetupModel';

const hooks = (claude: boolean, codex: boolean) => [
  { agent: 'claude' as const, cli_found: true, installed: claude },
  { agent: 'codex' as const, cli_found: true, installed: codex },
];

describe('offerFor', () => {
  it('offers this computer notifications, and never memory', () => {
    const offer = offerFor('local', undefined, hooks(false, true))!;
    expect(offer).toMatchObject({ machine: 'local', hooks: ['claude'], action: 'Turn On' });
    expect(offer.text).toBe('Connect Claude Code to Dolphin: get notified when they finish a turn.');
  });
  it('offers another machine notifications by name', () => {
    const offer = offerFor('gpu-box', 'gpu-box', hooks(false, false))!;
    expect(offer).toMatchObject({ machine: 'gpu-box', label: 'gpu-box', hooks: ['claude', 'codex'], action: 'Turn on notifications on gpu-box' });
    expect(offer.text).toBe('Turn on notifications on gpu-box: Claude Code and Codex there will tell you when they finish a turn.');
  });
  it('offers nothing when everything is on or no agent is installed', () => {
    expect(offerFor('gpu-box', 'gpu-box', hooks(true, true))).toBeNull();
    expect(offerFor('local', undefined, [{ agent: 'codex', cli_found: false, installed: false }])).toBeNull();
  });
});

describe('doneMessage', () => {
  it('says what changed, and that Codex asks for trust once', () => {
    expect(doneMessage(offerFor('local', undefined, hooks(false, true))!)).toBe('Claude Code: notifications are on.');
    expect(doneMessage(offerFor('gpu-box', 'gpu-box', hooks(true, false))!))
      .toBe('gpu-box: notifications are on for Codex. Codex will ask you once to trust Dolphin’s hook; choose Trust.');
  });
  it('remembers a dismissal per machine, not per port', () => {
    expect(dismissKey('local')).toBe('dolphin.desktop.agent-setup-dismissed:local');
    expect(dismissKey('me@gpu-box')).toBe('dolphin.desktop.agent-setup-dismissed:me@gpu-box');
    expect(dismissKey).toBe(agentSetupDismissKey);
  });
});
