import type { KeyboardEvent, PointerEvent } from 'react';

/* A stacked session window's bottom edge (2026-10-16). It replaced the
   browser's `resize: vertical` corner, which grew a window only as far as the
   pointer could travel: to the screen's bottom edge, or the stack's when the
   window was the last one, with nothing below to pull into.

   - The pointer is captured, so a drag that leaves the edge, the window or the
     screen keeps resizing until the button is let go.
   - The height follows the pointer in the stack's content, so a scroll during
     the drag moves the edge with it.
   - Held near the stack's bottom, the edge grows the window and scrolls the
     stack by the same amount each frame, for as long as it is held. That is
     direct manipulation, not decoration, so reduced motion keeps it.
   - Arrow keys step it (Shift for bigger steps), Home and End go to the
     limits, and a double click puts back the 45dvh default.

   The minimum is the window's CSS min-height (45dvh); the maximum is four
   viewport heights, enough for a very tall window and short of a lost one.
   During a drag the height is written to the window directly and committed
   once, so the workspace renders once per drag rather than once per frame. */

const AUTOSCROLL_EDGE = 48;
const AUTOSCROLL_MAX_STEP = 28;
const KEY_STEP = 16;
const KEY_BIG_STEP = 64;

/** The limits the workspace renders with, before a window is measured. */
export function defaultWindowHeightLimits(viewportHeight: number): { min: number; max: number } {
  const min = Math.round(viewportHeight * 0.45);
  return { min, max: Math.max(min, Math.round(viewportHeight * 4)) };
}

function measuredLimits(element: HTMLElement): { min: number; max: number } {
  const fallback = defaultWindowHeightLimits(window.innerHeight);
  const min = Math.round(parseFloat(getComputedStyle(element).minHeight) || fallback.min);
  return { min, max: Math.max(min, fallback.max) };
}

export default function WindowHeightResizer({ label, remembered, min, max, stack, target, onCommit }: {
  label: string;
  /** The height set at this edge, or null while the window has the default. */
  remembered: number | null;
  min: number;
  max: number;
  stack: () => HTMLElement | null;
  /** The window being resized. */
  target: () => HTMLElement | null;
  /** A new height, or null for the default. */
  onCommit: (height: number | null) => void;
}) {
  const height = Math.max(min, remembered ?? min);
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    const element = target();
    if (event.button !== 0 || !element) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const scroller = stack();
    const limits = measuredLimits(element);
    const startHeight = element.getBoundingClientRect().height;
    const startScroll = scroller?.scrollTop ?? 0;
    const startY = event.clientY;
    let pointerY = startY;
    let next = Math.round(startHeight);
    let frame = 0;
    let done = false;
    const clamp = (value: number) => Math.round(Math.min(limits.max, Math.max(limits.min, value)));
    const apply = (scrollTop: number) => {
      next = clamp(startHeight + pointerY - startY + scrollTop - startScroll);
      element.style.height = `${next}px`;
      handle.setAttribute('aria-valuenow', String(next));
    };
    const step = () => {
      frame = 0;
      if (!scroller) return;
      const bottom = scroller.getBoundingClientRect().bottom;
      const depth = pointerY - (bottom - AUTOSCROLL_EDGE);
      if (depth <= 0 || next >= limits.max) return;
      const amount = Math.max(2, Math.min(AUTOSCROLL_MAX_STEP, Math.round(depth / 2)));
      // Grow first, so the stack has the room to scroll into.
      apply(scroller.scrollTop + amount);
      scroller.scrollTop += amount;
      apply(scroller.scrollTop);
      frame = requestAnimationFrame(step);
    };
    const follow = () => {
      apply(scroller?.scrollTop ?? 0);
      if (!frame) frame = requestAnimationFrame(step);
    };
    const move = (moved: globalThis.PointerEvent) => { pointerY = moved.clientY; follow(); };
    const scrolled = () => apply(scroller?.scrollTop ?? 0);
    try { handle.setPointerCapture(event.pointerId); } catch { /* a synthetic pointer has nothing to capture */ }
    handle.dataset.dragging = '';
    const end = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(frame);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.removeEventListener('lostpointercapture', end);
      scroller?.removeEventListener('scroll', scrolled);
      delete handle.dataset.dragging;
      onCommit(next);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
    scroller?.addEventListener('scroll', scrolled, { passive: true });
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const by = event.shiftKey ? KEY_BIG_STEP : KEY_STEP;
    const now = Math.max(min, remembered ?? target()?.getBoundingClientRect().height ?? height);
    const next = event.key === 'ArrowDown' ? now + by
      : event.key === 'ArrowUp' ? now - by
        : event.key === 'Home' ? min
          : event.key === 'End' ? max : null;
    if (next === null) return;
    event.preventDefault();
    onCommit(Math.round(Math.min(max, Math.max(min, next))));
  };
  return (
    <div
      className="glass-window-resizer"
      role="separator"
      aria-orientation="horizontal"
      aria-label={`Resize ${label} window`}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(height)}
      title="Drag to resize. Double-click for the default height."
      tabIndex={0}
      onPointerDown={drag}
      onKeyDown={keys}
      onDoubleClick={() => onCommit(null)}
    />
  );
}
