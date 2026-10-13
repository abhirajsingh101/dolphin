import { setSetting } from '../settings';
import { applyTheme, readStoredTheme, type ThemeChoice } from '../theme';

/* The theme is a setting (spec: "Settings"), but the page is painted before any
   module loads, by public/theme-init.js, from `dolphin.theme`. setSetting('theme')
   already writes both keys (dolphin.theme is the source of truth); choosing a
   theme adds the page's data-theme. */

export function chooseTheme(choice: ThemeChoice): void {
  setSetting('theme', choice);
  applyTheme(choice);
}

function settingsBlobTheme(): unknown {
  try {
    const blob: unknown = JSON.parse(localStorage.getItem('dolphin.settings') ?? '{}');
    return blob && typeof blob === 'object' ? (blob as Record<string, unknown>).theme : undefined;
  } catch {
    return undefined;
  }
}

/** Once at start: the theme that painted the page is the one in effect. */
export function syncThemeSetting(): void {
  const painted = readStoredTheme();
  if (settingsBlobTheme() !== undefined && settingsBlobTheme() !== painted) setSetting('theme', painted);
}
