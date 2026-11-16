import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { useApi } from '../apiContext';
import Character from './Character';
import { CAST, castOf } from './cast';
import type { Mood } from './rig';

/* The character at the top of the Tasks tab. Clicking it shows the cast:
   pick one for this project, or hand the choice back to Dolphin, which picks
   from what is in the project folder. */

export default function CompanionPicker({ projectId, projectName, kind, chosen, mood, onChanged }: {
  projectId: string;
  projectName: string;
  kind: string | null | undefined;
  chosen: boolean;
  mood: Mood;
  onChanged: () => void;
}) {
  const { updateProject } = useApi();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const current = castOf(kind);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLButtonElement>('.dt-companion-pick')?.focus(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', escape); };
  }, [open]);
  async function choose(key: string | null) {
    setSaving(key ?? 'auto'); setError('');
    try {
      await updateProject(projectId, { companion: key });
      onChanged();
      setOpen(false);
    } catch {
      setError('Could not save the character. Try again.');
    } finally { setSaving(null); }
  }
  return <div className="dt-companion-picker" ref={root}>
    <button type="button" className="dt-companion-pick" aria-haspopup="true" aria-expanded={open}
      aria-label={`${current.name}, ${projectName}'s companion. Change character`} title="Change character" onClick={() => setOpen((v) => !v)}>
      <Character kind={current.key} mood={mood} size={30} />
    </button>
    {open && <div className="dt-companion-menu" role="menu" aria-label={`Character for ${projectName}`}>
      <div className="dt-companion-grid">
        {CAST.map((c) => {
          const on = chosen && c.key === current.key;
          return <button key={c.key} type="button" role="menuitemradio" aria-checked={on} disabled={!!saving}
            className="dt-companion-option" title={c.kind} onClick={() => void choose(c.key)}>
            <Character kind={c.key} mood="idle" size={32} />
            <span>{c.name}</span>
          </button>;
        })}
      </div>
      <button type="button" role="menuitemradio" aria-checked={!chosen} disabled={!!saving} className="dt-companion-auto" onClick={() => void choose(null)}>
        <span>{!chosen && <Check size={13} />}</span>
        <span><b>Automatic</b><small>{!chosen ? `${current.name}, picked from the project's files` : "Dolphin picks from the project's files"}</small></span>
      </button>
      {error && <p role="alert">{error}</p>}
    </div>}
  </div>;
}
