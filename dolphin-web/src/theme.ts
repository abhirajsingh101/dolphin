export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'dolphin.theme';

const CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

export function resolveTheme(
  choice: ThemeChoice,
  prefersDark: boolean,
): ResolvedTheme {
  if (choice === 'system') return prefersDark ? 'dark' : 'light';
  return choice;
}

export function readStoredChoice(raw: string | null): ThemeChoice {
  return CHOICES.includes(raw as ThemeChoice) ? (raw as ThemeChoice) : 'system';
}

export function nextChoice(current: ThemeChoice): ThemeChoice {
  const index = CHOICES.indexOf(current);
  return CHOICES[(index + 1) % CHOICES.length];
}

/**
 * Reads the persisted choice from localStorage. Falls back to 'system' if
 * storage is unavailable or access throws (privacy mode, disabled storage,
 * sandboxed iframes, etc.) — even referencing `localStorage` can throw in
 * some browsers, so this must not assume access is safe.
 */
export function readStoredTheme(): ThemeChoice {
  try {
    return readStoredChoice(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

/**
 * Persists the choice to localStorage. Losing persistence is acceptable
 * when storage is unavailable or throws (SecurityError, QuotaExceededError,
 * etc.); the theme must still apply visually, so failures are swallowed.
 */
export function persistTheme(choice: ThemeChoice): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Storage may be unavailable. Ignore — the applied theme is unaffected.
  }
}

/** Applies the resolved theme to <html>. Safe to call repeatedly. */
export function applyTheme(choice: ThemeChoice): ResolvedTheme {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = resolveTheme(choice, prefersDark);
  document.documentElement.setAttribute('data-theme', resolved);
  return resolved;
}
