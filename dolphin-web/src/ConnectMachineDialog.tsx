import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Laptop, LoaderCircle, Search, Server, X } from 'lucide-react';
import { filterMachines, machineBridge, SOURCE_LABEL, validTarget, type Machine } from './machines';
import './newSession.css';
import './connectMachine.css';

/* Connect to a Machine: everything Dolphin found on this computer (recent
   machines, ~/.ssh/config, shell history, the tailnet, known_hosts), a search
   that doubles as the address field, and one click or Enter to connect. The
   machine opens in its own window, which shows the setup and stays connected. */

export default function ConnectMachineDialog({ onClose, currentTarget }: { onClose: () => void; currentTarget: string | null }) {
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    machineBridge()?.machines?.().then(setMachines, () => setMachines([]));
  }, []);

  const typed = query.trim();
  const matches = useMemo(() => filterMachines(machines ?? [], typed), [machines, typed]);
  const exact = matches.some((machine) => machine.target.toLowerCase() === typed.toLowerCase());
  // Typing an address that isn't listed offers it first.
  const rows: { machine: Machine; typed?: boolean }[] = [
    ...(typed && !exact && validTarget(typed) ? [{ machine: { target: typed, label: typed, source: 'recent' as const }, typed: true }] : []),
    ...(currentTarget !== null && !typed ? [{ machine: { target: 'local', label: 'This Computer', source: 'recent' as const } }] : []),
    ...matches.map((machine) => ({ machine })),
  ];
  useEffect(() => setActive(0), [typed]);

  const connect = async (target: string) => {
    if (target !== 'local' && !validTarget(target)) {
      setError('Enter a machine like gpu-box, user@10.0.0.5 or ssh://user@host:2222.');
      return;
    }
    setOpening(target);
    const result = await machineBridge()?.openMachine?.(target);
    if (result?.error) {
      setError(result.error);
      setOpening('');
      return;
    }
    onClose();
  };

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setActive((index) => Math.min(rows.length - 1, index + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[active];
      if (row) void connect(row.machine.target);
      else if (typed) void connect(typed);
    }
  };

  // Group the found machines under where they came from, keeping their order.
  let lastGroup = '';
  return (
    <div className="new-session-scrim" onClick={onClose} role="presentation">
      <div className="new-session-panel connect-machine-panel" role="dialog" aria-modal="true" aria-label="Connect to a Machine"
        onClick={(event) => event.stopPropagation()} onKeyDown={onKey}>
        <header className="new-session-header">
          <h2>Connect to a Machine</h2>
          <button aria-label="Close" className="dt-btn dt-btn--ghost" onClick={onClose} type="button"><X aria-hidden="true" size={16} /></button>
        </header>
        <label className="connect-machine-search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={input}
            aria-label="Machine name or address"
            placeholder="Search, or type user@host"
            value={query}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(event) => { setQuery(event.target.value); setError(''); }}
            role="combobox"
            aria-expanded="true"
            aria-controls="connect-machine-list"
            aria-activedescendant={rows[active] ? `machine-${active}` : undefined}
          />
        </label>
        {error && <p className="connect-machine-error" role="alert">{error}</p>}
        <ul id="connect-machine-list" className="connect-machine-list" role="listbox" aria-label="Machines">
          {machines === null && <li className="connect-machine-note" role="status"><LoaderCircle className="update-spin" size={14} aria-hidden="true" /> Looking for your machines…</li>}
          {machines !== null && rows.length === 0 && (
            <li className="connect-machine-note">{typed ? 'Type a full address like user@10.0.0.5.' : 'No machines found yet. Type an address above: the name in your SSH config, user@host, or an IP.'}</li>
          )}
          {rows.map((row, index) => {
            const group = row.typed ? '' : row.machine.target === 'local' ? 'This computer' : SOURCE_LABEL[row.machine.source];
            const heading = group && group !== lastGroup ? group : '';
            lastGroup = group || lastGroup;
            const { machine } = row;
            return (
              <li key={`${machine.source}:${machine.target}:${row.typed ? 't' : ''}`} role="presentation">
                {heading && <p className="connect-machine-group" aria-hidden="true">{heading}</p>}
                <button
                  id={`machine-${index}`}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className="connect-machine-row"
                  disabled={opening !== ''}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => void connect(machine.target)}
                >
                  {machine.target === 'local' ? <Laptop size={16} aria-hidden="true" /> : <Server size={16} aria-hidden="true" />}
                  <span>
                    <strong>{row.typed ? `Connect to ${machine.target}` : machine.label}</strong>
                    {!row.typed && machine.detail && machine.detail !== machine.label && <small>{machine.detail}</small>}
                  </span>
                  {machine.open && <em className="connect-machine-open">Open</em>}
                  {machine.online !== undefined && <i className="connect-machine-dot" data-online={machine.online} title={machine.online ? 'Online' : 'Offline'} />}
                  {opening === machine.target ? <LoaderCircle className="update-spin" size={14} aria-hidden="true" /> : <ArrowRight className="connect-machine-go" size={14} aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="connect-machine-foot">
          Dolphin uses your SSH keys or asks for the password, sets itself up on the machine (about half a minute the first time), and stays connected. Your terminals keep running there when you close the window.
        </p>
      </div>
    </div>
  );
}
