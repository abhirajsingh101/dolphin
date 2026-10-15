import type { KeyboardEvent, PointerEvent } from 'react';
import { clampSidebarWidth, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from './layoutMemory';

/* The projects list's right edge: drag it, or focus it and use the arrow
   keys (Shift for bigger steps, Home and End for the limits). A double click
   puts back the default width. `onChange` follows the pointer; `onCommit`
   runs once the width settles, which is when it is remembered. */
export default function SidebarResizer({ width, onChange, onCommit }: {
  width: number;
  onChange: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    let next = width;
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = '';
    const move = (moved: globalThis.PointerEvent) => {
      next = clampSidebarWidth(startWidth + moved.clientX - startX);
      onChange(next);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      delete handle.dataset.dragging;
      onCommit(next);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 48 : 16;
    const next = event.key === 'ArrowLeft' ? width - step
      : event.key === 'ArrowRight' ? width + step
        : event.key === 'Home' ? SIDEBAR_MIN_WIDTH
          : event.key === 'End' ? SIDEBAR_MAX_WIDTH : null;
    if (next === null) return;
    event.preventDefault();
    onCommit(clampSidebarWidth(next));
  };
  return (
    <div
      className="glass-sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize projects list"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={width}
      title="Drag to resize. Double-click for the default width."
      tabIndex={0}
      onPointerDown={drag}
      onKeyDown={keys}
      onDoubleClick={() => onCommit(SIDEBAR_DEFAULT_WIDTH)}
    />
  );
}
