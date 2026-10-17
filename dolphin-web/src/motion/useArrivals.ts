import { useLayoutEffect, useRef } from 'react';

/* Which items of a list arrived while the person was looking at it.

   `scope` names what the list shows (a chat tab and the thread its messages
   were loaded for). The first list committed under a scope is a restore, and
   nothing in it is new: opening the app, switching tabs or threads, and the
   history a load brings in all appear in place. Afterwards an item is new
   when the previous commit did not have it.

   `standIn` lets an optimistic item hand over to the real one: when an item
   with a stand-in key leaves in the same commit that an item with that key
   appears, the newcomer is the same thing arriving for real, not new. */

export type Arrival = { id: string; standIn?: string };

export function arrivalsBetween(previous: Arrival[] | null, next: Arrival[]): Set<string> {
  const fresh = new Set<string>();
  if (!previous) return fresh;
  const before = new Set(previous.map(item => item.id));
  const after = new Set(next.map(item => item.id));
  const handedOver = new Set(previous.filter(item => item.standIn && !after.has(item.id)).map(item => item.standIn!));
  for (const item of next) {
    if (before.has(item.id)) continue;
    if (item.standIn && handedOver.has(item.standIn)) continue;
    fresh.add(item.id);
  }
  return fresh;
}

export function useArrivals(scope: string, items: Arrival[]): Set<string> {
  const committed = useRef<{ scope: string; items: Arrival[] } | null>(null);
  const previous = committed.current?.scope === scope ? committed.current.items : null;
  const fresh = arrivalsBetween(previous, items);
  useLayoutEffect(() => { committed.current = { scope, items }; });
  return fresh;
}
