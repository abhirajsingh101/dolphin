import { useCallback, useLayoutEffect, useRef } from 'react';

/** A function whose identity never changes and which always calls the latest `fn`. */
export function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  useLayoutEffect(() => { latest.current = fn; });
  return useCallback((...args: A) => latest.current(...args), []);
}
