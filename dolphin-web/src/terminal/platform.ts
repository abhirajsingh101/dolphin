/** Dolphin Desktop's menu sends find and zoom as commands (layout area); its
    accelerators fire before the page, so the terminal must not act twice.
    isMacPlatform lives in ../shortcutLabel (one owner). */
export function desktopOwnsTerminalShortcuts(
  target: unknown = typeof window === 'undefined' ? undefined : window,
): boolean {
  const bridge = (target as { dolphinDesktop?: { onCommand?: unknown } } | undefined)?.dolphinDesktop;
  return typeof bridge?.onCommand === 'function';
}
