import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, ChevronDown, Laptop, Server } from 'lucide-react';
import { AnimatePresence } from 'motion/react';

import { MotionPopover } from '../motion/MotionDialog';
import type { HealthMachine } from './healthTarget';
import '../connectMachine.css';

/* System Health's machine menu: the machine on screen as a chip in the header
   (the projects list's laptop or server icon with its connection dot), and a
   menu of this computer and every machine in the window. Choosing one moves
   the hash (#/health/<id>), so Back and reload keep it, and the overlay swaps
   the machine in place. The list is the window's live machine list, so it
   changes while it is open as machines connect and drop.

   Keyboard: Enter, Space or Down on the chip opens the menu on the machine
   shown; Up/Down/Home/End move; Escape and Tab close it back to the chip. The
   menu sits inside the overlay (the workspace beneath is inert), dropping
   from the chip with the shared menu motion. */

function MachineIcon({ item }: { item: HealthMachine }) {
  return (
    <span className="glass-machine-icon" aria-hidden="true">
      {item.kind === 'local' ? <Laptop size={14} /> : <Server size={14} />}
      <i className="glass-machine-dot" data-state={item.state === 'unknown' ? 'offline' : item.state} />
    </span>
  );
}

export default function HealthMachineSwitcher({ machines }: { machines: HealthMachine[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const current = machines.find((item) => item.current) ?? machines[0];

  useEffect(() => {
    if (!open) return;
    // Arriving never waits: the machine on screen has the focus on the first frame.
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    (items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const resize = () => setOpen(false);
    document.addEventListener('pointerdown', pointer);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      window.removeEventListener('resize', resize);
    };
  }, [open]);

  if (!current) return null;

  const close = () => { setOpen(false); button.current?.focus(); };
  const choose = (item: HealthMachine) => {
    close();
    if (!item.current) window.location.hash = item.href;
  };
  const onButtonKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); }
  };
  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Escape here closes the menu only, not System Health; Tab leaves from the chip.
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length
      : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length
        : event.key === 'Home' ? 0
          : event.key === 'End' ? items.length - 1
            : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next].focus();
  };

  return (
    <div className="health-machine-switch" ref={root}>
      <button
        ref={button}
        type="button"
        className="health-machine-trigger"
        data-state={current.state}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Showing ${current.label}, ${current.status}. Choose a machine`}
        title={`System Health of ${current.label} · ${current.status}`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onButtonKey}
      >
        <MachineIcon item={current} />
        <span className="health-machine-name">{current.label}</span>
        <ChevronDown size={13} aria-hidden="true" className="health-machine-chevron" />
      </button>
      <AnimatePresence>
        {open && (
          <MotionPopover key="menu" ref={menu} side="below" align="left" className="machine-menu health-machine-menu" role="menu" aria-label="Machines" onKeyDown={onMenuKey}>
            <p className="health-machine-group" aria-hidden="true">Show health of</p>
            {machines.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitemradio"
                aria-checked={item.current}
                className="health-machine-item"
                data-state={item.state}
                onClick={() => choose(item)}
              >
                <MachineIcon item={item} />
                <span>
                  <strong>{item.label}</strong>
                  <small data-state={item.state}>{item.status}</small>
                </span>
                {item.current && <Check size={14} aria-hidden="true" className="health-machine-check" />}
              </button>
            ))}
          </MotionPopover>
        )}
      </AnimatePresence>
    </div>
  );
}
