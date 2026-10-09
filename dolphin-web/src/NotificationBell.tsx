import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Terminal, X } from 'lucide-react';
import { fetchNotifications, markNotificationsRead, notificationStreamUrl } from './api';
import type { AppNotification } from './types';

const TOAST_MS = 8_000;
const MAX_TOASTS = 3;

export type NotificationTarget = { projectId: string; projectName: string; sessionName: string };

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function label(item: AppNotification): string {
  return `${item.project_name ?? 'No project'} / ${item.session_name}`;
}

function targetOf(item: AppNotification): NotificationTarget | null {
  return item.project_id && item.project_name
    ? { projectId: item.project_id, projectName: item.project_name, sessionName: item.session_name }
    : null;
}

/** Every finished agent turn, pushed by the backend; a click opens its session. */
export default function NotificationBell({ onOpen }: { onOpen: (target: NotificationTarget) => void }) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [permission, setPermission] = useState(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const [toasts, setToasts] = useState<AppNotification[]>([]);
  const [holding, setHolding] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, right: 0 });
  const root = useRef<HTMLDivElement>(null);
  const known = useRef(new Set<string>());
  const openRef = useRef(open);
  openRef.current = open;
  const dismiss = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  const load = useCallback(async () => {
    try {
      const list = await fetchNotifications();
      known.current = new Set(list.items.map((item) => item.id));
      setItems(list.items);
      setUnread(list.unread_count);
    } catch {
      /* The stream's reconnect retries; a stale list is better than an error badge. */
    }
  }, []);

  const read = useCallback((item: AppNotification) => {
    if (item.read) return;
    setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, read: true } : entry)));
    setUnread((count) => Math.max(0, count - 1));
    void markNotificationsRead({ ids: [item.id] }).then((result) => setUnread(result.unread_count), () => undefined);
  }, []);

  useEffect(() => {
    void load();
    const stream = new EventSource(notificationStreamUrl);
    // Every (re)connect resynchronises, so nothing missed while offline is lost.
    stream.onopen = () => void load();
    stream.addEventListener('notification', (event) => {
      let item: AppNotification;
      try {
        item = JSON.parse((event as MessageEvent).data);
      } catch {
        return;
      }
      if (known.current.has(item.id)) return;
      known.current.add(item.id);
      setItems((current) => [item, ...current].slice(0, 100));
      if (item.read) return;
      setUnread((count) => count + 1);
      // In view, show it beside the bell; the open list already shows it.
      if (document.visibilityState === 'visible' && !openRef.current) {
        setToasts((current) => [item, ...current.filter((toast) => toast.id !== item.id)].slice(0, MAX_TOASTS));
      }
      if (document.visibilityState === 'hidden' && typeof Notification !== 'undefined'
          && Notification.permission === 'granted') {
        const popup = new Notification(`${label(item)} finished a turn`, {
          body: item.summary || `${item.provider === 'claude' ? 'Claude Code' : 'Codex'} is waiting for you.`,
          tag: item.id,
        });
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
    return () => stream.close();
  }, [load, read]);

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
              <li key={item.id}>
                <button
                  className="glass-toast-open"
                  disabled={!target}
                  title={target ? `Open ${label(item)}` : 'This session is outside every project.'}
                  onClick={() => {
                    if (!target) return;
                    read(item);
                    dismiss(item.id);
                    onOpen(target);
                  }}
                >
                  <Terminal size={15} aria-hidden="true" />
                  <span>
                    <strong>{label(item)} finished</strong>
                    {item.summary && <span className="glass-notification-summary">{item.summary}</span>}
                    <small>{item.provider === 'claude' ? 'Claude Code' : 'Codex'} · {ago(item.finished_at)}</small>
                  </span>
                </button>
                <button className="glass-toast-dismiss" aria-label={`Dismiss ${label(item)}`} onClick={() => dismiss(item.id)}>
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
              setItems((current) => current.map((entry) => ({ ...entry, read: true })));
              setUnread(0);
              void markNotificationsRead({ all: true }).then((result) => setUnread(result.unread_count), () => undefined);
            }}>Mark all read</button>
          </header>
          {items.length === 0 ? (
            <p className="glass-notification-empty">Finished agent turns show up here.</p>
          ) : (
            <ul>
              {items.map((item) => {
                const target = targetOf(item);
                return (
                  <li key={item.id} data-read={item.read}>
                    <button
                      disabled={!target}
                      title={target ? `Open ${label(item)}` : 'This session is outside every project.'}
                      onClick={() => {
                        if (!target) return;
                        read(item);
                        setOpen(false);
                        onOpen(target);
                      }}
                    >
                      <Terminal size={15} aria-hidden="true" />
                      <span>
                        <strong>{label(item)}</strong>
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
