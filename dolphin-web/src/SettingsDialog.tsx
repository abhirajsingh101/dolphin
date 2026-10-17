import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Bell, Brain, Keyboard, Minus, Palette, Plus, RefreshCw, Search, Server, ShieldCheck, SlidersHorizontal, SquareTerminal, X,
  type LucideIcon,
} from 'lucide-react';

import type { AgentCli } from './api';
import { useApi } from './apiContext';
import { bridge, desktopSettingsBridge, type DesktopSettings } from './desktop/bridge';
import { currentPlatform, isMacPlatform } from './shortcutLabel';
import { machineBridge, type MachineLink } from './machines';
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN, useSetting, type Settings } from './settings';
import { zoomedFontSize } from './terminal/fontZoom';
import { chooseTheme } from './workspace/themeChoice';
import { UpdateSettings } from './UpdateControl';
import { SKILL_SUGGESTIONS_CHANGED } from './skillSuggestionsModel';
import { useDialogParts, useDialogPresent } from './motion/dialogParts';
import './settingsDialog.css';

/* Settings (⌘, in Dolphin Desktop; "Settings…" in the palette everywhere).
   One scrolling page of sections, with a sidebar that jumps to a section and
   follows the one in view, and a search that keeps only the sections it
   matches. Every change applies at once; there is no Save. Memory, Updates,
   Machines and Privacy exist only in Dolphin Desktop. */

type SectionInfo = { id: string; title: string; icon: LucideIcon; keywords: string; desktop?: boolean };

const SECTIONS: SectionInfo[] = [
  { id: 'general', title: 'General', icon: SlidersHorizontal, keywords: 'new session default agent claude code codex tmux terminal shell ask every time' },
  { id: 'appearance', title: 'Appearance', icon: Palette, keywords: 'theme light dark system colour color' },
  { id: 'terminal', title: 'Terminal', icon: SquareTerminal, keywords: 'text size font zoom' },
  { id: 'notifications', title: 'Notifications', icon: Bell, keywords: 'system notifications turn finished alert' },
  { id: 'memory', title: 'Memory', icon: Brain, keywords: 'memory brain gbrain projects summaries search skill skills suggestions plugins', desktop: true },
  { id: 'updates', title: 'Updates', icon: RefreshCw, keywords: 'update channel stable beta version', desktop: true },
  { id: 'machines', title: 'Machines', icon: Server, keywords: 'machines ssh keys connect disconnect remote', desktop: true },
  { id: 'privacy', title: 'Privacy & logs', icon: ShieldCheck, keywords: 'crash reports logs privacy diagnostics', desktop: true },
  { id: 'shortcuts', title: 'Shortcuts', icon: Keyboard, keywords: 'keyboard shortcuts keys palette' },
];

type StartOption = { value: Settings['newSession.defaultAgent']; title: string; detail: string };
const START_OPTIONS: StartOption[] = [
  { value: 'ask', title: 'Ask every time', detail: 'Choose what to start each time.' },
  { value: 'claude', title: 'Claude Code', detail: 'Starts Claude Code.' },
  { value: 'codex', title: 'Codex', detail: 'Starts Codex.' },
  { value: 'shell', title: 'tmux Session', detail: 'A shell that keeps running after Dolphin closes.' },
  { value: 'terminal', title: 'Terminal', detail: 'A plain shell, without tmux.' },
];

function Segmented<T extends string>({ name, legend, value, options, onChange }: { name: string; legend: string; value: T; options: [T, string][]; onChange: (value: T) => void }) {
  return (
    <fieldset className="settings-segmented">
      <legend className="settings-sr">{legend}</legend>
      {options.map(([option, label]) => (
        <label key={option} data-checked={value === option || undefined}>
          <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} />
          <span>{label}</span>
        </label>
      ))}
    </fieldset>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="settings-toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="settings-sr">{label}</span>
      <span className="settings-toggle-track" aria-hidden="true"><span /></span>
    </label>
  );
}

function Row({ label, hint, children, wide = false }: { label: string; hint?: ReactNode; children?: ReactNode; wide?: boolean }) {
  return (
    <div className={`settings-row${wide ? ' settings-row--wide' : ''}`}>
      <div className="settings-row-text">
        <span className="settings-row-label">{label}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </div>
      {children && <div className="settings-row-control">{children}</div>}
    </div>
  );
}

function Section({ info, shown, children }: { info: SectionInfo; shown: boolean; children: ReactNode }) {
  return (
    <section id={`settings-${info.id}`} className="settings-section" aria-labelledby={`settings-${info.id}-title`} hidden={!shown} data-section={info.id}>
      <h3 id={`settings-${info.id}-title`}>{info.title}</h3>
      <div className="settings-card">{children}</div>
    </section>
  );
}

const linkState = (state: MachineLink['state']) =>
  state === 'connected' ? 'Connected' : state === 'failed' ? "Couldn't connect" : state === 'offline' ? 'Disconnected' : 'Connecting…';

export default function SettingsDialog({ onClose, machines = [], onConnect, returnFocus }: { onClose: () => void; returnFocus?: HTMLElement | null; machines?: MachineLink[]; onConnect?: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const { getAgentClis, fetchSkillSuggestions, setSkillSuggestionsEnabled, refreshSkillSuggestions } = useApi();
  const [theme] = useSetting('theme');
  const [fontSize, setFontSize] = useSetting('terminal.fontSize');
  const [start, setStart] = useSetting('newSession.defaultAgent');
  const [notify, setNotify] = useSetting('notifications.system');
  const desktopStore = desktopSettingsBridge();
  const [desktop, setDesktop] = useState<DesktopSettings | null>(() => desktopStore?.get() ?? null);
  const [agents, setAgents] = useState<AgentCli[] | null>(null);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState('general');
  const jumping = useRef(0);
  const mac = isMacPlatform(currentPlatform());
  const mod = mac ? '⌘' : 'Ctrl+';
  const remote = machines.filter((link) => link.kind === 'ssh');

  const sections = SECTIONS.filter((section) => !section.desktop || desktop);
  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => new Set(sections
    .filter((section) => !needle || `${section.title} ${section.keywords}`.toLowerCase().includes(needle))
    .map((section) => section.id)), [needle, desktop]);

  // Focus goes back the moment Settings starts closing, not once its exit
  // animation ends, so it cannot land on top of whatever opened next.
  const { Scrim, Panel } = useDialogParts();
  const present = useDialogPresent();
  useEffect(() => {
    if (!present) return;
    opener.current = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    panel.current?.querySelector<HTMLElement>('.settings-search input')?.focus();
    return () => { if (opener.current?.isConnected) opener.current.focus(); };
  }, [present]);

  // Which agents this machine has: only Dolphin Desktop's helper answers.
  useEffect(() => {
    if (!desktopStore) return;
    let live = true;
    getAgentClis().then((found) => { if (live) setAgents(found); }, () => { if (live) setAgents([]); });
    return () => { live = false; };
  }, []);

  // Skill suggestions: only a helper that has them answers; an older one shows no row.
  const [skills, setSkills] = useState<boolean | null>(null);
  const [checking, setChecking] = useState<'idle' | 'working' | 'started' | 'failed'>('idle');
  const skillSaves = useRef(0);
  useEffect(() => {
    if (!desktopStore) return;
    let live = true;
    fetchSkillSuggestions().then(
      (found) => { if (live) setSkills(typeof found?.enabled === 'boolean' ? found.enabled : null); },
      () => { if (live) setSkills(null); },
    );
    return () => { live = false; };
  }, []);
  const saveSkills = (enabled: boolean) => {
    const before = skills;
    setSkills(enabled);
    setSaveError(false);
    const mine = ++skillSaves.current;
    setSkillSuggestionsEnabled(enabled).then(
      (saved) => {
        if (mine !== skillSaves.current) return;
        if (typeof saved?.enabled === 'boolean') setSkills(saved.enabled);
        window.dispatchEvent(new Event(SKILL_SUGGESTIONS_CHANGED));
      },
      () => { if (mine === skillSaves.current) { setSkills(before); setSaveError(true); } },
    );
  };
  const checkSkills = () => {
    setChecking('working');
    refreshSkillSuggestions().then(
      () => { setChecking('started'); window.dispatchEvent(new Event(SKILL_SUGGESTIONS_CHANGED)); },
      () => setChecking('failed'),
    );
  };

  // The sidebar follows the section at the top of the page.
  useEffect(() => {
    const root = body.current;
    if (!root) return;
    const follow = () => {
      if (Date.now() < jumping.current) return;  // a sidebar click chose the section
      const top = root.getBoundingClientRect().top + 24;
      const sections = [...root.querySelectorAll<HTMLElement>('[data-section]:not([hidden])')];
      const id = sections.find((section) => section.getBoundingClientRect().bottom > top)?.getAttribute('data-section');
      if (id) setCurrent(id);
    };
    root.addEventListener('scroll', follow, { passive: true });
    return () => root.removeEventListener('scroll', follow);
  }, [desktop]);

  const jump = (id: string) => {
    setCurrent(id);
    jumping.current = Date.now() + 800;
    const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    body.current?.querySelector(`#settings-${id}`)?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
  };

  const saves = useRef(0);
  const [saveError, setSaveError] = useState(false);
  const saveDesktop = (patch: Partial<DesktopSettings>) => {
    if (!desktopStore) return;
    setDesktop((value) => (value ? { ...value, ...patch } : value));
    setSaveError(false);
    const mine = ++saves.current;
    Promise.resolve().then(() => desktopStore.set(patch)).then(
      (saved) => { if (mine === saves.current) setDesktop(saved); },
      () => { if (mine === saves.current) { setDesktop(desktopStore.get()); setSaveError(true); } },
    );
  };
  const cycleFocus = (backwards: boolean) => {
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)') ?? [])]
      .filter((item) => !item.closest('[hidden]'));
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + (backwards ? -1 : 1) + items.length) % items.length].focus();
  };
  const info = (id: string) => SECTIONS.find((section) => section.id === id)!;
  const found = (agent: 'claude' | 'codex') => agents?.find((row) => row.agent === agent)?.found;

  return (
    <Scrim className="settings-scrim" role="presentation" onClick={onClose}>
      <Panel ref={panel} className="settings-panel" tabIndex={-1} role="dialog" aria-modal="true" aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); if (query) setQuery(''); else onClose(); }
          else if (event.key === 'Tab') { event.preventDefault(); cycleFocus(event.shiftKey); }
        }}>
        <nav className="settings-nav" aria-label="Settings sections">
          <h2>Settings</h2>
          <label className="settings-search">
            <Search size={14} aria-hidden="true" />
            <input type="search" placeholder="Search" aria-label="Search settings" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <ul>
            {sections.map((section) => {
              const Icon = section.icon;
              return (
                <li key={section.id} hidden={!matches.has(section.id)}>
                  <button type="button" aria-current={current === section.id ? 'true' : undefined} onClick={() => jump(section.id)}>
                    <Icon size={15} aria-hidden="true" />{section.title}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="settings-main">
          <header className="settings-header">
            <span>{matches.size ? info(matches.has(current) ? current : [...matches][0]).title : 'No results'}</span>
            <button type="button" aria-label="Close settings" onClick={onClose}><X size={16} aria-hidden="true" /></button>
          </header>
          <div ref={body} className="settings-body">
            {saveError && <p className="settings-alert" role="alert">Couldn't save that setting. It is back to what it was.</p>}
            {!matches.size && <p className="settings-empty">No settings match “{query}”. Try “theme”, “agent” or “memory”.</p>}

            <Section info={info('general')} shown={matches.has('general')}>
              <Row wide label="New sessions start" hint={`What + starts. Option-click or Alt-click + to choose anyway.`}>
                <fieldset className="settings-options">
                  <legend className="settings-sr">Start new sessions with</legend>
                  {START_OPTIONS.map((option) => (
                    <label key={option.value} data-checked={start === option.value || undefined}>
                      <input type="radio" name="start" value={option.value} checked={start === option.value} onChange={() => setStart(option.value)} />
                      <span><strong>{option.title}</strong><small>{option.detail}</small></span>
                    </label>
                  ))}
                </fieldset>
              </Row>
              {desktop && (
                <Row label="Agents on this computer" hint="Dolphin uses the agent you choose when it is installed, and the other one when it is not.">
                  <span className="settings-agents">
                    {(['claude', 'codex'] as const).map((agent) => (
                      <span key={agent} className="settings-agent" data-found={agents === null ? undefined : String(Boolean(found(agent)))}>
                        {agent === 'claude' ? 'Claude Code' : 'Codex'}
                        <small>{agents === null ? 'Checking…' : found(agent) ? 'Installed' : 'Not found'}</small>
                      </span>
                    ))}
                  </span>
                </Row>
              )}
            </Section>

            <Section info={info('appearance')} shown={matches.has('appearance')}>
              <Row label="Theme" hint="System follows your computer's light or dark setting.">
                <Segmented name="theme" legend="Theme" value={theme} onChange={chooseTheme} options={[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]} />
              </Row>
            </Section>

            <Section info={info('terminal')} shown={matches.has('terminal')}>
              <Row label="Text size" hint={desktop ? `${mod}= and ${mod}− change it from any terminal; ${mod}0 resets it.` : 'Applies to every terminal.'}>
                <div className="settings-stepper" role="group" aria-label="Text size">
                  <button type="button" aria-label="Smaller terminal text" disabled={fontSize <= TERMINAL_FONT_SIZE_MIN} onClick={() => setFontSize(zoomedFontSize(fontSize, 'zoom-out'))}><Minus size={14} aria-hidden="true" /></button>
                  <output aria-live="polite">{fontSize} px</output>
                  <button type="button" aria-label="Larger terminal text" disabled={fontSize >= TERMINAL_FONT_SIZE_MAX} onClick={() => setFontSize(zoomedFontSize(fontSize, 'zoom-in'))}><Plus size={14} aria-hidden="true" /></button>
                </div>
              </Row>
            </Section>

            <Section info={info('notifications')} shown={matches.has('notifications')}>
              <Row label="System notifications" hint="When an agent finishes a turn and Dolphin is not in front.">
                <Toggle label="Show system notifications when an agent finishes a turn" checked={notify} onChange={setNotify} />
              </Row>
            </Section>

            {desktop && (
              <>
                <Section info={info('memory')} shown={matches.has('memory')}>
                  <Row label="Dolphin memory" hint="Downloads about 550 MB once.">
                    <Toggle label="Use Dolphin memory (downloads about 550 MB once)" checked={desktop.memory} onChange={(memory) => saveDesktop({ memory })} />
                  </Row>
                  <p className="settings-note">Memory reads what you ask Claude Code and Codex, and their replies, on every connected machine, and keeps each project's state on this computer. Your own Claude Code or Codex writes the summaries.</p>
                  {skills !== null && (
                    <>
                      <Row label="Skill suggestions" hint="Once a day, suggests up to two well-known skills that would improve your recent work. Dolphin never installs them.">
                        <span className="settings-actions">
                          <button type="button" disabled={!skills || checking === 'working'} onClick={checkSkills}>Check Now</button>
                          <Toggle label="Suggest skills that would improve your recent work" checked={skills} onChange={saveSkills} />
                        </span>
                      </Row>
                      <p className="settings-note" role="status" hidden={checking === 'idle'}>
                        {checking === 'working' ? 'Asking for a fresh look…'
                          : checking === 'started' ? 'Looking now. New suggestions appear above the chat.'
                            : checking === 'failed' ? "Couldn't start a check. Make sure Dolphin's helper is running, then try Check Now again." : ''}
                      </p>
                    </>
                  )}
                </Section>

                <Section info={info('updates')} shown={matches.has('updates')}>
                  <div className="settings-pad"><UpdateSettings /></div>
                  <Row label="Channel" hint="Beta gets new versions first.">
                    <Segmented name="channel" legend="Channel" value={desktop.updateChannel} onChange={(updateChannel) => saveDesktop({ updateChannel })} options={[['stable', 'Stable'], ['beta', 'Beta']]} />
                  </Row>
                </Section>

                <Section info={info('machines')} shown={matches.has('machines')}>
                  {remote.length === 0 && <Row label="No other machines yet" hint="Connect to one to work there." />}
                  {remote.map((link) => (
                    <Row key={link.id} label={link.label} hint={linkState(link.state)}>
                      <span className="settings-actions">
                        {link.state !== 'connected' && <button type="button" onClick={() => link.target && machineBridge()?.reconnect?.(link.target)}>Reconnect</button>}
                        {link.offerKey && <button type="button" onClick={() => link.target && void machineBridge()?.setupKey?.(link.target)}>Set Up Key</button>}
                        <button type="button" onClick={() => link.target && machineBridge()?.closeMachine?.(link.target)}>Disconnect</button>
                      </span>
                    </Row>
                  ))}
                  {onConnect && <div className="settings-pad"><button type="button" onClick={() => { onClose(); onConnect(); }}>Connect to a Machine…</button></div>}
                </Section>

                <Section info={info('privacy')} shown={matches.has('privacy')}>
                  <Row label="Crash reports" hint="A change here takes effect the next time Dolphin starts.">
                    <Segmented name="crashes" legend="When Dolphin crashes" value={desktop.crashReports} onChange={(crashReports) => saveDesktop({ crashReports })} options={[['off', 'Off'], ['local', 'Keep a report on this computer']]} />
                  </Row>
                  <p className="settings-note">Reports are never uploaded unless you send one yourself.</p>
                  <Row label="Logs" hint="The helper's and the app's logs, in your file manager.">
                    <button type="button" onClick={() => bridge()?.openLogs?.()}>Open Logs</button>
                  </Row>
                </Section>
              </>
            )}

            <Section info={info('shortcuts')} shown={matches.has('shortcuts')}>
              {([
                ['Command palette', `${mod}K`],
                ['Settings', `${mod},`],
                ['Fold the chat', `${mod}/`],
                ['Terminal text size', `${mod}=  ${mod}−  ${mod}0`],
                ['Choose what + starts', mac ? 'Option-click +' : 'Alt-click +'],
              ] as const).map(([label, keys]) => (
                <Row key={label} label={label}><kbd className="settings-kbd">{keys}</kbd></Row>
              ))}
            </Section>
          </div>
        </div>
      </Panel>
    </Scrim>
  );
}
