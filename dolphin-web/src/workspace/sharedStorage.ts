import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/* State kept in localStorage that every Dolphin window shares (pins, the
   projects list's folds; windowScope.ts lists what each window keeps for
   itself). Another window's write arrives as a `storage` event and replaces
   this window's copy, so a window never writes back a list that is out of
   date. `parse` turns the stored text (or null) into a value, and must accept
   anything. */
export function useSharedStorage<T>(key: string, parse: (raw: string | null) => T): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => parse(read(key)));
  useEffect(() => {
    const heard = (event: StorageEvent) => {
      // null: storage was cleared.
      if (event.key === key || event.key === null) setValue(parse(read(key)));
    };
    window.addEventListener('storage', heard);
    return () => window.removeEventListener('storage', heard);
  }, [key, parse]);
  useEffect(() => {
    // Writing back what was just heard is harmless: an unchanged value fires no event.
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage is optional */ }
  }, [key, value]);
  return [value, setValue];
}

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** The stored text as a list of strings, or empty. */
export function parseIds(raw: string | null): string[] {
  try {
    const saved: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
