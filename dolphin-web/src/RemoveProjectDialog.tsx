import { useEffect, useRef, useState } from 'react';
import { FolderMinus, X } from 'lucide-react';
import { deleteProject } from './api';
import './newSession.css';

/* Remove a project from Dolphin. Only Dolphin's record goes, with its tasks:
   the folder and any terminals running in it stay exactly as they are. */

export default function RemoveProjectDialog({ project, onClose, onRemoved }: {
  project: { id: string; name: string; path: string | null };
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [state, setState] = useState<'idle' | 'working' | 'failed'>('idle');
  const [error, setError] = useState('');
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { cancelRef.current?.focus(); }, []);

  const remove = async () => {
    setState('working');
    try {
      await deleteProject(project.id);
      onRemoved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setState('failed');
    }
  };

  return (
    <div className="new-session-scrim" onClick={onClose} role="presentation">
      <div
        aria-label={`Remove ${project.name}`}
        aria-modal="true"
        className="new-session-panel remove-project-panel"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}
        role="alertdialog"
      >
        <header className="new-session-header">
          <h2>Remove {project.name}?</h2>
          <button aria-label="Close" className="dt-btn dt-btn--ghost" onClick={onClose} type="button">
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        <div className="remove-project-body">
          <span className="remove-project-icon" aria-hidden="true"><FolderMinus size={18} /></span>
          <p>
            Dolphin stops showing this project and its tasks. The folder
            {project.path ? <> <code>{project.path}</code></> : null} and any terminals running in it stay as they are.
          </p>
        </div>
        {state === 'failed' && <p className="remove-project-error" role="alert">Could not remove it: {error}</p>}
        <footer className="remove-project-actions">
          <button ref={cancelRef} type="button" className="remove-project-cancel" onClick={onClose}>Cancel</button>
          <button type="button" className="remove-project-confirm" disabled={state === 'working'} onClick={() => void remove()}>
            {state === 'working' ? 'Removing…' : 'Remove Project'}
          </button>
        </footer>
      </div>
    </div>
  );
}
