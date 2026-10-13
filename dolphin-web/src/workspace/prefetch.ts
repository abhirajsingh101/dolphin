/* Load heavy chunks while the page is idle, so the first terminal and the
   first Markdown reply do not wait on the network. */

export const loadTerminalPane = () => import('@dolphin-terminal/react/pane');
/* Dolphin's terminal features (WebGL, Unicode 11, links): needed only once a
   terminal opens, so they load with the pane rather than with the workspace. */
export const loadTerminalFeatures = () => import('../terminal');

type Idle = { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };

export function prefetchWhenIdle(load: () => Promise<unknown>, timeout = 1500): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const run = () => void load().catch(() => undefined);
  const idle = window as Idle;
  if (idle.requestIdleCallback) {
    const id = idle.requestIdleCallback(run, { timeout });
    return () => idle.cancelIdleCallback?.(id);
  }
  const timer = setTimeout(run, timeout);
  return () => clearTimeout(timer);
}
