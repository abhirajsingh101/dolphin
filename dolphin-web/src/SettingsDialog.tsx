import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, X } from 'lucide-react';

import { bridge, desktopSettingsBridge, type DesktopSettings } from './desktop/bridge';
import { currentPlatform, isMacPlatform } from './shortcutLabel';
import { machineBridge, type MachineLink } from './machines';
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN, useSetting } from './settings';
import { zoomedFontSize } from './terminal/fontZoom';
import { chooseTheme } from './workspace/themeChoice';
import './settingsDialog.css';

/* Settings (⌘, in Dolphin Desktop; "Settings…" in the palette everywhere).
   Every change applies at once; there is no Save. The Updates, Memory, Crash
   reports, Machines and Logs sections exist only in Dolphin Desktop. */

function Choice<T extends string>({ name, legend, value, options, onChange }: { name: string; legend: string; value: T; options: [T, string][]; onChange: (value: T) => void }) {
  return (
    <fieldset className="settings-choice">
      <legend>{legend}</legend>
      {options.map(([option, label]) => (
        <label key={option}>
          <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

export default function SettingsDialog({ onClose, machines = [], onConnect, returnFocus }: { onClose: () => void; returnFocus?: HTMLElement | null; machines?: MachineLink[]; onConnect?: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [theme] = useSetting('theme');
  const [fontSize, setFontSize] = useSetting('terminal.fontSize');
  const [agent, setAgent] = useSetting('newSession.defaultAgent');
  const [notify, setNotify] = useSetting('notifications.system');
  const desktopStore = desktopSettingsBridge();
  const [desktop, setDesktop] = useState<DesktopSettings | null>(() => desktopStore?.get() ?? null);
  const mac = isMacPlatform(currentPlatform());
  const remote = machines.filter((link) => link.kind === 'ssh');

  useEffect(() => {
    opener.current = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    panel.current?.querySelector<HTMLElement>('input:checked, input, button')?.focus();
    return () => { if (opener.current?.isConnected) opener.current.focus(); };
  }, []);

  const saves = useRef(0);
  const [saveError, setSaveError] = useState(false);
  const saveDesktop = (patch: Partial<DesktopSettings>) => {
    if (!desktopStore) return;
    setDesktop((current) => (current ? { ...current, ...patch } : current));
    setSaveError(false);
    const mine = ++saves.current;
    Promise.resolve().then(() => desktopStore.set(patch)).then(
      (saved) => { if (mine === saves.current) setDesktop(saved); },
      () => { if (mine === saves.current) { setDesktop(desktopStore.get()); setSaveError(true); } },
    );
  };
  const cycleFocus = (backwards: boolean) => {
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + (backwards ? -1 : 1) + items.length) % items.length].focus();
  };

  return (
    <div className="settings-scrim" role="presentation" onClick={onClose}>
      <div ref={panel} className="settings-panel" tabIndex={-1} role="dialog" aria-modal="true" aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); onClose(); }
          else if (event.key === 'Tab') { event.preventDefault(); cycleFocus(event.shiftKey); }
        }}>
        <header className="settings-header">
          <h2>Settings</h2>
          <button type="button" aria-label="Close settings" onClick={onClose}><X size={16} aria-hidden="true" /></button>
        </header>
        <div className="settings-body">
          {saveError && <p className="settings-note" role="alert">Couldn't save that setting. It is back to what it was.</p>}
          <section aria-labelledby="settings-appearance">
            <h3 id="settings-appearance">Appearance</h3>
            <Choice name="theme" legend="Theme" value={theme} onChange={chooseTheme} options={[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]} />
          </section>
          <section aria-labelledby="settings-terminal">
            <h3 id="settings-terminal">Terminal</h3>
            <div className="settings-row">
              <span id="settings-font">Text size</span>
              <div className="settings-stepper" role="group" aria-labelledby="settings-font">
                <button type="button" aria-label="Smaller terminal text" disabled={fontSize <= TERMINAL_FONT_SIZE_MIN} onClick={() => setFontSize(zoomedFontSize(fontSize, 'zoom-out'))}><Minus size={14} aria-hidden="true" /></button>
                <output aria-live="polite">{fontSize} px</output>
                <button type="button" aria-label="Larger terminal text" disabled={fontSize >= TERMINAL_FONT_SIZE_MAX} onClick={() => setFontSize(zoomedFontSize(fontSize, 'zoom-in'))}><Plus size={14} aria-hidden="true" /></button>
              </div>
            </div>
            {desktopStore && <p className="settings-note">{mac ? '⌘= and ⌘− change it from any terminal; ⌘0 resets it.' : 'Ctrl+= and Ctrl+− change it from any terminal; Ctrl+0 resets it.'}</p>}
          </section>
          <section aria-labelledby="settings-sessions">
            <h3 id="settings-sessions">New sessions</h3>
            <Choice name="agent" legend="Start with" value={agent} onChange={setAgent} options={[['claude', 'Claude Code'], ['codex', 'Codex'], ['shell', 'Shell']]} />
          </section>
          <section aria-labelledby="settings-notifications">
            <h3 id="settings-notifications">Notifications</h3>
            <label className="settings-check"><input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} />Show system notifications when an agent finishes a turn</label>
          </section>
          {desktop && (
            <>
              <section aria-labelledby="settings-updates">
                <h3 id="settings-updates">Updates</h3>
                <Choice name="channel" legend="Channel" value={desktop.updateChannel} onChange={(updateChannel) => saveDesktop({ updateChannel })} options={[['stable', 'Stable'], ['beta', 'Beta']]} />
              </section>
              <section aria-labelledby="settings-memory">
                <h3 id="settings-memory">Memory</h3>
                <label className="settings-check"><input type="checkbox" checked={desktop.memory} onChange={(event) => saveDesktop({ memory: event.target.checked })} />Use Dolphin memory (downloads about 400 MB once)</label>
              </section>
              <section aria-labelledby="settings-crashes">
                <h3 id="settings-crashes">Crash reports</h3>
                <Choice name="crashes" legend="When Dolphin crashes" value={desktop.crashReports} onChange={(crashReports) => saveDesktop({ crashReports })} options={[['off', 'Off'], ['local', 'Keep a report on this computer']]} />
                <p className="settings-note">Reports are never uploaded unless you send one yourself. A change here takes effect the next time Dolphin starts.</p>
              </section>
              <section aria-labelledby="settings-machines">
                <h3 id="settings-machines">Machines and keys</h3>
                {remote.length === 0 && <p className="settings-note">No other machines yet. Connect to one to work there.</p>}
                <ul className="settings-machines">
                  {remote.map((link) => (
                    <li key={link.id}>
                      <span><strong>{link.label}</strong><small>{link.state === 'connected' ? 'Connected' : link.state === 'failed' ? "Couldn't connect" : link.state === 'offline' ? 'Disconnected' : 'Connecting…'}</small></span>
                      {link.state !== 'connected' && <button type="button" onClick={() => link.target && machineBridge()?.reconnect?.(link.target)}>Reconnect</button>}
                      {link.offerKey && <button type="button" onClick={() => link.target && void machineBridge()?.setupKey?.(link.target)}>Set Up Key</button>}
                      <button type="button" onClick={() => link.target && machineBridge()?.closeMachine?.(link.target)}>Disconnect</button>
                    </li>
                  ))}
                </ul>
                {onConnect && <button type="button" className="settings-link" onClick={() => { onClose(); onConnect(); }}>Connect to a Machine…</button>}
              </section>
              <section aria-labelledby="settings-logs">
                <h3 id="settings-logs">Logs</h3>
                <button type="button" onClick={() => bridge()?.openLogs?.()}>Open Logs</button>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
