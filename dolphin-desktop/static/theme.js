// The launch, Connect and SSH-prompt pages take the workspace's theme choice
// from the main process (src/theme.ts), not only the system's, and follow it
// when it changes. Loaded in <head>, before the page paints.
(() => {
  const bridge = window.dolphinDesktop || window.dolphinAskpass;
  const apply = (theme) => { document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light'; };
  const fromSystem = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  apply(bridge && bridge.theme ? bridge.theme() : fromSystem());
  if (bridge && bridge.onTheme) bridge.onTheme(apply);
  else matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => apply(fromSystem()));
})();
