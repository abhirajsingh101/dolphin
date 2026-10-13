import { describe, expect, it } from 'vitest';
import { isMacPlatform, shortcutLabel } from './shortcutLabel';

describe('shortcut labels', () => {
  it('shows ⌘ on macOS and Ctrl elsewhere', () => {
    expect(shortcutLabel('K', 'darwin')).toBe('⌘ K');
    expect(shortcutLabel('K', 'MacIntel')).toBe('⌘ K');
    expect(shortcutLabel('K', 'linux')).toBe('Ctrl K');
    expect(shortcutLabel('K', 'Win32')).toBe('Ctrl K');
    expect(shortcutLabel('K', '')).toBe('Ctrl K');
    expect(isMacPlatform('')).toBe(false);
  });
});
