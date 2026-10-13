import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { pickKeys, rememberBounded } from './cachePruning';
import { createPortal } from 'react-dom';
import { Bell, Terminal, X } from 'lucide-react';
import { api, type Api } from './api';
import type { AppNotification } from './types';
import { notificationTitle, systemNotificationText, wantsBrowserNotification } from './notificationText';
import { getSetting } from './settings';

const TOAST_MS = 8_000;
const MAX_TOASTS = 3;

export type NotificationTarget = { projectId: string; projectName: string; sessionName: string; machine?: string };
/** A backend whose finished turns the bell shows. Dolphin Desktop passes one
    per machine in the window; `label` names any but this computer. */
export type NotificationSource = { id: string; label?: string; api: Api };
type Item = AppNotification & { machine: string; machineLabel?: string; uid: string };

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function targetOf(item: Item): NotificationTarget | null {
  return item.project_id && item.project_name
    ? { projectId: item.project_id, projectName: item.project_name, sessionName: item.session_name, machine: item.machine }
    : null;
}

const LOCAL_SOURCES: NotificationSource[] = [{ id: 'local', api }];

/** Every finished agent turn, pushed by the backend; a click opens its session. */
/** Turns from one project (or, with no project, one session) replace each other. */
function sameOrigin(a: Item, b: Item): boolean {
  if (a.machine !== b.machine) return false;
  return a.project_id ? a.project_id === b.project_id : !b.project_id && a.session_name === b.session_name;
}

export default function NotificationBell({ onOpen, onTurn, sources = LOCAL_SOURCES }: { onOpen: (target: NotificationTarget) => void; onTurn?: (machine: string) => void; sources?: NotificationSource[] }) {
  // Each machine's list and unread count, merged for display.
  const [itemsBy, setItemsBy] = useState<Record<string, Item[]>>({});
  const [unreadBy, setUnreadBy] = useState<Record<string, number>>({});
  const live = sources.map((source) => source.id);
  const items = live.flatMap((id) => itemsBy[id] ?? []).sort((a, b) => b.finished_at.localeCompare(a.finished_at));
  const unread = live.reduce((sum, id) => sum + (unreadBy[id] ?? 0), 0);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  const sourceOf = (machine: string) => sourcesRef.current.find((source) => source.id === machine);
  const setItems = (machine: string, change: (current: Item[]) => Item[]) => setItemsBy((all) => ({ ...all, [machine]: change(all[machine] ?? []) }));
  const setUnread = (machine: string, change: number | ((current: number) => number)) =>
    setUnreadBy((all) => ({ ...all, [machine]: typeof change === 'function' ? change(all[machine] ?? 0) : change }));
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const [toasts, setToasts] = useState<Item[]>([]);
  const [holding, setHolding] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, right: 0 });
  const root = useRef<HTMLDivElement>(null);
  const known = useRef(new Set<string>());
  const openRef = useRef(open);
  openRef.current = open;
  const dismiss = useCallback((uid: string) => setToasts((current) => current.filter((toast) => toast.uid !== uid)), []);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const onTurnRef = useRef(onTurn);
  onTurnRef.current = onTurn;

  const tag = (source: NotificationSource, item: AppNotification): Item => ({ ...item, machine: source.id, machineLabel: source.label, uid: `${source.id} ${item.id}` });

  const load = useCallback(async (source: NotificationSource) => {
    try {
      const list = await source.api.fetchNotifications();
      for (const item of list.items) rememberBounded(known.current, `${source.id} ${item.id}`);
      setItems(source.id, () => list.items.map((item) => tag(source, item)));
      setUnread(source.id, list.unread_count);
    } catch {
      /* The stream's reconnect retries; a stale list is better than an error badge. */
    }
  }, []);

  const read = useCallback((item: Item) => {
    if (item.read) return;
    const source = sourceOf(item.machine);
    setItems(item.machine, (current) => current.map((entry) => (entry.id === item.id ? { ...entry, read: true } : entry)));
    setUnread(item.machine, (count) => Math.max(0, count - 1));
    void source?.api.markNotificationsRead({ ids: [item.id] }).then((result) => setUnread(item.machine, result.unread_count), () => undefined);
  }, []);

  const sourcesKey = sources.map((source) => `${source.id} ${source.api.API_BASE} ${source.api.API_TOKEN}`).join('|');
  useEffect(() => {
    // A machine that left the window takes its list and count with it.
    const liveIds = sourcesRef.current.map((source) => source.id);
    setItemsBy((all) => pickKeys(all, liveIds));
    setUnreadBy((all) => pickKeys(all, liveIds));
    const streams = sourcesRef.current.map((source) => {
      void load(source);
      const stream = new EventSource(source.api.notificationStreamUrl);
      // Every (re)connect resynchronises, so nothing missed while offline is lost.
      stream.onopen = () => void load(source);
      // A session's turn changed there: that machine's sessions refresh now.
      stream.addEventListener('turn', () => onTurnRef.current?.(source.id));
      stream.addEventListener('notification', (event) => {
        let raw: AppNotification;
        try {
          raw = JSON.parse((event as MessageEvent).data);
        } catch {
          return;
        }
        const item = tag(source, raw);
        if (known.current.has(item.uid)) return;
        rememberBounded(known.current, item.uid);
        // A project's newest turn replaces its earlier ones: the backend has
        // marked those read, so they leave the count and their pop-ups go.
        setItems(source.id, (current) => [item, ...current.map((entry) => (
          !entry.read && sameOrigin(entry, item) ? { ...entry, read: true } : entry))].slice(0, 100));
        setToasts((current) => current.filter((toast) => !sameOrigin(toast, item)));
        if (item.read) return;
        void source.api.fetchNotifications(1).then((list) => setUnread(source.id, list.unread_count), () => setUnread(source.id, (count) => count + 1));
        // In view, show it beside the bell; the open list already shows it.
        if (document.visibilityState === 'visible' && !openRef.current) {
          setToasts((current) => [item, ...current.filter((toast) => toast.uid !== item.uid)].slice(0, MAX_TOASTS));
        }
        const desktopApp = Boolean((window as { dolphinDesktop?: { notify?: unknown } }).dolphinDesktop?.notify);
        if (wantsBrowserNotification({
          hidden: document.visibilityState === 'hidden',
          focused: document.hasFocus(),
          granted: typeof Notification !== 'undefined' && Notification.permission === 'granted',
          enabled: getSetting('notifications.system'),
          desktop: desktopApp,
        })) {
          const text = systemNotificationText(item, item.machineLabel);
          const popup = new Notification(text.title, { body: text.body, tag: item.uid });
          popup.onclick = () => {
            window.focus();
            popup.close();
            const target = targetOf(item);
            if (target) {
              read(item);
              onOpenRef.current(target);
            }
          };
        }
      });
      return stream;
    });
    return () => streams.forEach((stream) => stream.close());
  }, [load, read, sourcesKey]);

  // Dolphin Desktop mirrors the unread count on the dock or taskbar icon.
  useEffect(() => {
    (window as { dolphinDesktop?: { setBadge?: (count: number) => void } }).dolphinDesktop?.setBadge?.(unread);
  }, [unread]);

  // Each pop-up leaves after 8 s, but not while the pointer or focus is on one.
  useEffect(() => {
    if (holding || toasts.length === 0) return;
    const timer = window.setTimeout(() => setToasts((current) => current.slice(0, -1)), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toasts, holding]);

  useEffect(() => {
    if (open) setToasts([]);
  }, [open]);

  // Pop-ups live in a top-level layer so a fullscreen project window cannot
  // cover them; they are anchored just under the bell.
  useLayoutEffect(() => {
    if (toasts.length === 0) return;
    const place = () => {
      const box = root.current?.getBoundingClientRect();
      if (box) setAnchor({ top: box.bottom + 8, right: Math.max(8, window.innerWidth - box.right) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [toasts.length]);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', close);
    };
  }, [open]);

  return (
    <div className="glass-notifications" ref={root}>
      <button
        className="glass-bell"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <Bell size={18} />
        {unread > 0 && <span className="glass-bell-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {!open && toasts.length > 0 && createPortal(
        <ul className="glass-notification-toasts" aria-label="New notifications" aria-live="polite" style={{ top: anchor.top, right: anchor.right }}
          onPointerEnter={() => setHolding(true)} onPointerLeave={() => setHolding(false)}
          onFocus={() => setHolding(true)} onBlur={() => setHolding(false)}>
          {toasts.map((item) => {
            const target = targetOf(item);
            return (
              <li key={item.uid}>
                <button
                  className="glass-toast-open"
                  disabled={!target}
                  title={target ? `Open ${notificationTitle(item)}` : 'This session is outside every project.'}
                  onClick={() => {
                    if (!target) return;
                    read(item);
                    dismiss(item.uid);
                    onOpen(target);
                  }}
                >
                  <Terminal size={15} aria-hidden="true" />
                  <span>
                    <strong>{notificationTitle(item)}{item.machineLabel && <span className="glass-machine-chip">{item.machineLabel}</span>}</strong>
                    {item.summary && <span className="glass-notification-summary">{item.summary}</span>}
                    <small>{item.provider === 'claude' ? 'Claude Code' : 'Codex'} · {ago(item.finished_at)}</small>
                  </span>
                </button>
                <button className="glass-toast-dismiss" aria-label={`Dismiss ${notificationTitle(item)}`} onClick={() => dismiss(item.uid)}>
                  <X size={13} />
                </button>
              </li>
            );
          })}
        </ul>,
        document.body,
      )}
      {open && (
        <div className="glass-notification-panel" role="dialog" aria-label="Notifications">
          <header>
            <strong>Notifications</strong>
            <button disabled={!unread} onClick={() => {
              for (const source of sourcesRef.current) {
                setItems(source.id, (current) => current.map((entry) => ({ ...entry, read: true })));
                setUnread(source.id, 0);
                void source.api.markNotificationsRead({ all: true }).then((result) => setUnread(source.id, result.unread_count), () => undefined);
              }
            }}>Mark all read</button>
          </header>
          {items.length === 0 ? (
            <p className="glass-notification-empty">Finished agent turns show up here.</p>
          ) : (
            <ul>
              {items.map((item) => {
                const target = targetOf(item);
                return (
                  <li key={item.uid} data-read={item.read}>
                    <button
                      disabled={!target}
                      title={target ? `Open ${notificationTitle(item)}` : 'This session is outside every project.'}
                      onClick={() => {
                        if (!target) return;
                        read(item);
                        setOpen(false);
                        onOpen(target);
                      }}
                    >
                      <Terminal size={15} aria-hidden="true" />
                      <span>
                        <strong>{notificationTitle(item)}{item.machineLabel && <span className="glass-machine-chip">{item.machineLabel}</span>}</strong>
                        {item.summary && <span className="glass-notification-summary">{item.summary}</span>}
                        <small>{item.provider === 'claude' ? 'Claude Code' : 'Codex'} · {ago(item.finished_at)}</small>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {permission === 'default' && (
            <footer>
              <button onClick={() => void Notification.requestPermission().then(setPermission)}>
                Show system pop-ups while Dolphin is in the background
              </button>
            </footer>
          )}
        </div>
      )}
    </div>
  );
}
