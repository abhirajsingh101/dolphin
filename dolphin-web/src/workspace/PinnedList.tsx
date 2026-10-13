import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

import TerminalActivityBadge from '../terminal/TerminalActivityBadge';

/* Pinned sessions, at the top of the projects list: one 28px row each, in the
   order you drag them to. ⌘1…⌘9 (Dolphin Desktop) open them in that order.
   Unpinning removes only the shortcut; the session keeps running. */

export type PinnedItem = { id: string; label: string; project: string; session: string; selected: boolean; glyph: ReactNode; shortcut: string | null; activityKey: string };

function PinnedRow({ item, onOpen, onUnpin, glance }: { item: PinnedItem; onOpen: () => void; onUnpin: () => void; glance?: Record<string, unknown> }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  return (
    <li ref={setNodeRef} className="glass-pinned-row" data-selected={item.selected} data-dragging={isDragging || undefined}
      style={{ transform: CSS.Transform.toString(transform), transition }}>
      <button ref={setActivatorNodeRef} {...attributes} {...listeners} {...glance} type="button" data-nav-row className="glass-pinned-open"
        aria-label={`Open pinned ${item.label}`} title={item.label} onClick={onOpen}>
        {item.glyph}
        <span className="glass-pinned-name"><strong>{item.session}</strong><small>{item.project}</small></span>
        <TerminalActivityBadge activityKey={item.activityKey} />
        {item.shortcut && <kbd>{item.shortcut}</kbd>}
      </button>
      <button type="button" className="glass-pinned-unpin" aria-label={`Unpin ${item.label}`} title="Unpin. The session keeps running." onClick={onUnpin}>
        <X size={12} aria-hidden="true" />
      </button>
    </li>
  );
}

export default function PinnedList({ items, onOpen, onUnpin, onReorder, glance }: {
  items: PinnedItem[];
  onOpen: (id: string) => void;
  onUnpin: (id: string) => void;
  onReorder: (ids: string[]) => void;
  glance?: (id: string) => Record<string, unknown>;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  if (!items.length) return null;
  const ids = items.map((item) => item.id);
  return (
    <section className="glass-pinned" aria-label="Pinned sessions">
      <h2 className="glass-pinned-title">Pinned</h2>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={({ active, over }) => {
        if (over && active.id !== over.id) onReorder(arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
      }}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul>{items.map((item) => <PinnedRow key={item.id} item={item} onOpen={() => onOpen(item.id)} onUnpin={() => onUnpin(item.id)} glance={glance?.(item.id)} />)}</ul>
        </SortableContext>
      </DndContext>
    </section>
  );
}
