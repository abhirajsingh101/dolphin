import { useEffect, useState } from 'react';
import { FolderGit2, FolderOpen, Server } from 'lucide-react';
import { request } from './api';
import './desktopStart.css';

/* Dolphin Desktop's first run, in the project list: open a folder, or pick one
   of the git repositories used most recently on this machine. */

type Repo = { name: string; path: string };

function shortPath(path: string) {
  return path.replace(/^\/(home|Users)\/[^/]+/, '~');
}

export default function DesktopStart({ onOpenFolder, onLink, onConnect }: {
  onOpenFolder: () => void;
  onConnect?: () => void;
  onLink: (repo: Repo) => Promise<void>;
}) {
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [linking, setLinking] = useState('');

  useEffect(() => {
    request<Repo[]>('/api/desktop/recent-repos').then(setRepos).catch(() => setRepos([]));
  }, []);

  return (
    <section className="desktop-start" aria-label="Get started">
      <p>Open a folder to start. Each project gets its own terminals and tasks.</p>
      <button type="button" className="desktop-start-open" onClick={onOpenFolder}>
        <FolderOpen size={14} aria-hidden="true" />
        Open Folder
      </button>
      {onConnect && (
        <button type="button" className="desktop-start-connect" onClick={onConnect}>
          <Server size={14} aria-hidden="true" />
          Work on Another Machine
        </button>
      )}
      {repos === null && <p className="desktop-start-note" role="status">Looking for your repositories…</p>}
      {repos && repos.length > 0 && (
        <>
          <h3>Recent repositories</h3>
          <ul>
            {repos.map((repo) => (
              <li key={repo.path}>
                <button type="button" disabled={linking !== ''} title={repo.path}
                  onClick={() => {
                    setLinking(repo.path);
                    void onLink(repo).finally(() => setLinking(''));
                  }}>
                  <FolderGit2 size={14} aria-hidden="true" />
                  <span><strong>{repo.name}</strong><small>{linking === repo.path ? 'Opening…' : shortPath(repo.path)}</small></span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
