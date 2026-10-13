import { useEffect, useState } from 'react';
import { FolderGit2, FolderOpen, Server } from 'lucide-react';
import type { AgentCli } from './api';
import { useApi } from './apiContext';
import FirstRunChecklist from './FirstRunChecklist';
import './desktopStart.css';

/* Dolphin Desktop's first run, in a machine's part of the project list: open a
   folder, or pick one of the git repositories used most recently on that
   machine. */

type Repo = { name: string; path: string };

function shortPath(path: string) {
  return path.replace(/^\/(home|Users)\/[^/]+/, '~');
}

export default function DesktopStart({ machine, onOpenFolder, onLink, onConnect, onInstall, onSignIn }: {
  /** Another machine's name; this computer's start says nothing about where. */
  machine?: string;
  onOpenFolder: () => void;
  onConnect?: () => void;
  onLink: (repo: Repo) => Promise<void>;
  /** The checklist's Install: runs the installer in a new terminal. */
  onInstall?: (agent: AgentCli) => Promise<void> | void;
  /** The checklist's Sign In: starts the agent, which asks the user to sign in. */
  onSignIn?: (agent: 'claude' | 'codex') => Promise<void> | void;
}) {
  const { request } = useApi();
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [linking, setLinking] = useState('');

  useEffect(() => {
    request<Repo[]>('/api/desktop/recent-repos').then(setRepos).catch(() => setRepos([]));
  }, []);

  return (
    <section className="desktop-start" aria-label={machine ? `Get started on ${machine}` : 'Get started'}>
      <FirstRunChecklist onInstall={onInstall} onSignIn={onSignIn} />
      <p>{machine ? `Open a folder on ${machine} to start.` : 'Open a folder to start.'} Each project gets its own terminals and tasks.</p>
      <button type="button" className="desktop-start-open desktop-start-primary" onClick={onOpenFolder}>
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
