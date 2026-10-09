/* Applies the persisted theme before first paint so a dark-mode reload does
   not flash light. Deliberately duplicates readStoredChoice() from theme.ts:
   this runs before any module can load. Keep the two in sync. */
(function () {
  try {
    var stored = localStorage.getItem('dolphin.theme');
    var choice = stored === 'light' || stored === 'dark' ? stored : 'system';
    var dark =
      choice === 'dark' ||
      (choice === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
