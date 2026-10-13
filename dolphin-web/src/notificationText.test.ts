import { describe, expect, it } from 'vitest';
import { notificationTitle, systemNotificationText, wantsBrowserNotification } from './notificationText';

const item = { session_name: 'docs', project_name: 'Atlas', summary: 'Ported the homepage.', provider: 'claude' as const };

describe('notification text', () => {
  it('is titled session · project', () => {
    expect(notificationTitle(item)).toBe('docs · Atlas');
    expect(notificationTitle({ ...item, project_name: null })).toBe('docs · No project');
  });
  it('names the machine only when it is another computer', () => {
    expect(systemNotificationText(item)).toEqual({ title: 'docs · Atlas', body: 'Ported the homepage.' });
    expect(systemNotificationText(item, 'gpu-box').title).toBe('docs · Atlas · gpu-box');
  });
  it('says who finished when the summary is empty', () => {
    expect(systemNotificationText({ ...item, summary: '  ' }).body).toBe('Claude Code finished its turn.');
    expect(systemNotificationText({ ...item, summary: '', provider: 'codex' }).body).toBe('Codex finished its turn.');
  });
});

describe('wantsBrowserNotification', () => {
  const base = { hidden: false, focused: false, granted: true, enabled: true, desktop: false };
  it('raises one while the window is unfocused or hidden', () => {
    expect(wantsBrowserNotification(base)).toBe(true);
    expect(wantsBrowserNotification({ ...base, hidden: true, focused: true })).toBe(true);
    expect(wantsBrowserNotification({ ...base, focused: true })).toBe(false);
  });
  it('never without permission, with the setting off, or in Dolphin Desktop', () => {
    expect(wantsBrowserNotification({ ...base, granted: false })).toBe(false);
    expect(wantsBrowserNotification({ ...base, enabled: false })).toBe(false);
    expect(wantsBrowserNotification({ ...base, desktop: true })).toBe(false);
  });
});
