import { Check, Folder, FolderGit2, FolderPlus, LoaderCircle, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Tree, type NodeRendererProps, type TreeApi } from 'react-arborist';

import {
  createWorkspaceDirectory,
  fetchWorkspaceDirectories,
  fetchWorkspaceRoots,
} from './api';
import {
  directoryNodes,
  groupResultsByRoot,
  insertChildren,
  rootNodes,
  type PickerNode,
  type ResultGroup,
} from './projectPickerModel';
import type { WorkspaceDirectory, WorkspaceRoot } from './types';
import './projectPicker.css';

/* The coarse-pointer regime, in one place because two things have to agree on
   it: the `@media (max-width: 820px) and (pointer: coarse)` block in
   projectPicker.css, and the `rowHeight` handed to <Tree> below. react-arborist
   positions every row absolutely at `index * rowHeight`, so a CSS-only height
   bump would overlap rows rather than grow them -- the row height has to rise
   on both sides of that boundary or on neither. */
const COARSE_POINTER = '(max-width: 820px) and (pointer: coarse)';
const ROW_HEIGHT = 30;
const COARSE_ROW_HEIGHT = 44;

function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(COARSE_POINTER).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(COARSE_POINTER);
    const update = () => setCoarse(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return coarse;
}

/* <Tree> takes a pixel width, not a percentage. Measure the element that
   actually holds it so a narrow dialog never gets a desktop-width tree. */
function useContentWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const measured = element.clientWidth;
      if (measured > 0) setWidth(measured);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

function rowLabel(data: PickerNode): string {
  if (!data.isRoot) return data.name;
  // The "Not found" badge is content, and an explicit aria-label replaces
  // content: without folding it in, a screen reader hears "Root /srv/work,
  // button" with no hint that the root is missing.
  return data.exists ? `Root ${data.path}` : `Root ${data.path} (not found)`;
}

function NodeRow({ node, style, dragHandle }: NodeRendererProps<PickerNode>) {
  const data = node.data;
  return (
    <div
      className={`picker-row${node.isSelected ? ' is-selected' : ''}`}
      ref={dragHandle}
      style={style}
    >
      <button
        aria-label={rowLabel(data)}
        className="picker-row-button"
        onClick={() => {
          node.select();
          if (!node.isLeaf) node.toggle();
        }}
        type="button"
      >
        {data.isProject ? (
          <FolderGit2 aria-hidden="true" size={14} />
        ) : (
          <Folder aria-hidden="true" size={14} />
        )}
        <span className="picker-row-name">{data.name}</span>
        {data.isRoot && !data.exists ? (
          <small className="picker-row-missing">Not found</small>
        ) : null}
      </button>
    </div>
  );
}

export default function ProjectPickerDialog({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const [roots, setRoots] = useState<WorkspaceRoot[]>([]);
  const [rootsState, setRootsState] = useState<'loading' | 'ready' | 'failed'>(
    'loading',
  );
  const [nodes, setNodes] = useState<PickerNode[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [groups, setGroups] = useState<ResultGroup[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rootsAttempt, setRootsAttempt] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<TreeApi<PickerNode> | undefined>(undefined);
  const coarsePointer = useCoarsePointer();
  const treeHost = useContentWidth(560);
  // Guards the async callbacks below (loadChildren, createFolder) that are
  // kicked off from a click rather than an effect: closing the dialog mid
  // expand or mid create must not write state into an unmounted component.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let ignore = false;
    setRootsState('loading');
    fetchWorkspaceRoots()
      .then((loaded) => {
        if (ignore) return;
        setRoots(loaded);
        setNodes(rootNodes(loaded));
        setRootsState('ready');
      })
      .catch(() => {
        if (ignore) return;
        /* Deliberately not the caught message. A backend that predates this
           endpoint answers 404, and "Not Found" over an empty body tells the
           operator nothing about what to do -- the dialog owns this copy. */
        setRootsState('failed');
      });
    return () => {
      ignore = true;
    };
  }, [rootsAttempt]);

  /* Search spans every root, so it replaces the tree rather than filtering
     it -- a filtered tree would hide the root a match lives under. */
  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setGroups([]);
      return undefined;
    }
    let ignore = false;
    const timer = window.setTimeout(() => {
      fetchWorkspaceDirectories({ query: term, showHidden })
        .then((list) => {
          if (!ignore) setGroups(groupResultsByRoot(list.directories, roots));
        })
        .catch(() => {
          if (!ignore) setGroups([]);
        });
    }, 150);
    return () => {
      ignore = true;
      window.clearTimeout(timer);
    };
  }, [query, roots, showHidden]);

  const loadChildren = useCallback(
    async (path: string) => {
      const list = await fetchWorkspaceDirectories({ root: path, showHidden });
      if (!mountedRef.current) return;
      setNodes((current) =>
        insertChildren(current, path, directoryNodes(list.directories)),
      );
    },
    [showHidden],
  );

  /* `void loadChildren(path)` was an unhandled rejection: expanding a folder
     that has been deleted or become unreadable since it was listed left the
     node open, empty and silent, and ErrorBoundary cannot catch an async
     rejection. Every other async path here reports; this one now matches. */
  const expandNode = useCallback(
    (path: string, name: string) => {
      loadChildren(path).catch(() => {
        if (!mountedRef.current) return;
        treeRef.current?.close(path);
        setError(
          `Could not open ${name}. It may have been moved or deleted since this list loaded — pick another folder, or reopen the picker to refresh.`,
        );
      });
    },
    [loadChildren],
  );

  const createFolder = useCallback(async () => {
    const parent = selected ?? roots[0]?.path;
    if (!parent) return;
    const name = window.prompt(`New folder inside ${parent}`)?.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const created: WorkspaceDirectory = await createWorkspaceDirectory(parent, name);
      await loadChildren(parent);
      if (!mountedRef.current) return;
      setSelected(created.path);
    } catch (caught: unknown) {
      if (!mountedRef.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [loadChildren, roots, selected]);

  /* Mirrors CommandPalette's cycleFocus (commandPalette.css / CommandPalette.tsx)
     so Tab stays inside the dialog rather than escaping to the rail behind
     the scrim -- the same "not a free choice" dialog pattern this component
     otherwise follows. */
  function cycleFocus(shiftKey: boolean) {
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(
      panel.querySelectorAll<HTMLElement>('input, button:not(:disabled)'),
    );
    if (focusables.length === 0) return;
    const activeIndex = focusables.indexOf(document.activeElement as HTMLElement);
    const delta = shiftKey ? -1 : 1;
    const nextIndex =
      ((activeIndex === -1 ? 0 : activeIndex) + delta + focusables.length) %
      focusables.length;
    focusables[nextIndex]?.focus();
  }

  const searching = query.trim().length > 0;
  const browsePrompt =
    roots.length === 0
      ? 'Clear the search to browse the folder tree.'
      : roots.length === 1
        ? 'Clear the search to browse the workspace root.'
        : `Clear the search to browse all ${roots.length} workspace roots.`;

  return (
    <div className="picker-scrim" onClick={onClose} role="presentation">
      <div
        aria-label="Link a project"
        aria-modal="true"
        className="picker-panel"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          } else if (event.key === 'Tab') {
            /* react-arborist's container handles Tab itself (preventDefault
               plus focusNextElement) and does not stop propagation, so running
               cycleFocus after it advanced focus twice and skipped a control.
               A tree is one tab stop; let it own its own escape. */
            if ((event.target as Element | null)?.closest('[role="tree"]')) return;
            event.preventDefault();
            cycleFocus(event.shiftKey);
          }
        }}
        ref={panelRef}
        role="dialog"
      >
        <header className="picker-header">
          <h2>Link a project</h2>
          <button
            aria-label="Close the project picker"
            className="dt-btn dt-btn--ghost"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" size={16} />
          </button>
        </header>

        <input
          aria-label="Search folders"
          autoFocus
          className="dt-input"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search folders…"
          value={query}
        />

        {/* Spec §4/§6: hidden directories are excluded by default, with a
            toggle. A wrapping label is the accessible name (design contract
            §7), and the native checkbox keeps this keyboard reachable. */}
        <label className="picker-hidden-toggle">
          <input
            checked={showHidden}
            onChange={(event) => {
              setShowHidden(event.target.checked);
              /* Drop every cached listing. Children fetched under the old
                 setting are stale by definition -- the hidden entries were
                 never in that response -- and the <Tree> key below remounts
                 so react-arborist's own open state agrees that nothing is
                 expanded any more. */
              setNodes(rootNodes(roots));
            }}
            type="checkbox"
          />
          <span className="picker-hidden-check">
            <Check aria-hidden="true" size={12} />
          </span>
          <span>Show hidden folders</span>
        </label>

        {rootsState === 'failed' ? (
          <div className="picker-error picker-error--retry" role="alert">
            <span>
              Could not load the workspace roots. Check that the Dolphin backend
              is running, then try again.
            </span>
            <button
              className="dt-btn dt-btn--ghost"
              onClick={() => setRootsAttempt((attempt) => attempt + 1)}
              type="button"
            >
              Try Again
            </button>
          </div>
        ) : null}

        {error ? (
          <p className="picker-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="picker-body">
          <div className="picker-body-inner" ref={treeHost.ref}>
            {searching ? (
              groups.length === 0 ? (
                <p className="picker-empty">No folders match that. {browsePrompt}</p>
              ) : (
                groups.map((group) => (
                  <section className="picker-group" key={group.root.path}>
                    <h3>{group.root.path}</h3>
                    {group.results.map((result) => (
                      <button
                        className={`picker-result${selected === result.path ? ' is-selected' : ''}`}
                        key={result.path}
                        onClick={() => setSelected(result.path)}
                        type="button"
                      >
                        {result.is_project ? (
                          <FolderGit2 aria-hidden="true" size={14} />
                        ) : (
                          <Folder aria-hidden="true" size={14} />
                        )}
                        <span>{result.path}</span>
                      </button>
                    ))}
                  </section>
                ))
              )
            ) : nodes.length === 0 ? (
              /* Without this the body was simply empty when the roots call
                 failed: no tree, no message, nothing to act on. */
              <p className="picker-empty">
                {rootsState === 'failed'
                  ? 'No folders to browse yet. Your workspace roots will appear here once they load.'
                  : rootsState === 'loading'
                    ? 'Loading your workspace roots…'
                    : 'No workspace root is configured. Set DOLPHIN_WORKSPACE_ROOTS to a folder you own, then restart Dolphin.'}
              </p>
            ) : (
              <Tree<PickerNode>
                childrenAccessor={(node) => node.children}
                data={nodes}
                disableDrag
                disableDrop
                disableEdit
                height={360}
                idAccessor="path"
                indent={18}
                /* Remounts when the toggle flips. react-arborist owns its own
                   open state, so resetting `nodes` alone would leave an
                   already-expanded folder open over children it will never
                   re-fetch -- stale results, which is the one thing the toggle
                   must not produce. */
                key={showHidden ? 'tree-with-hidden' : 'tree-without-hidden'}
                onSelect={(picked) => setSelected(picked[0]?.data.path ?? null)}
                onToggle={(path) => {
                  const find = (list: PickerNode[]): PickerNode | null => {
                    for (const node of list) {
                      if (node.path === path) return node;
                      const nested = node.children ? find(node.children) : null;
                      if (nested) return nested;
                    }
                    return null;
                  };
                  const node = find(nodes);
                  if (node && !node.childrenLoaded) expandNode(path, node.name);
                }}
                openByDefault={false}
                overscanCount={8}
                ref={treeRef}
                rowHeight={coarsePointer ? COARSE_ROW_HEIGHT : ROW_HEIGHT}
                width={Math.max(treeHost.width, 240)}
              >
                {NodeRow}
              </Tree>
            )}
          </div>
        </div>

        <footer className="picker-footer">
          <code className="picker-selection">{selected ?? 'No folder selected'}</code>
          <div className="picker-actions">
            <button
              className="dt-btn dt-btn--ghost"
              disabled={busy}
              onClick={() => void createFolder()}
              type="button"
            >
              <FolderPlus aria-hidden="true" size={14} />
              New Folder
            </button>
            <button className="dt-btn dt-btn--ghost" onClick={onClose} type="button">
              Cancel
            </button>
            <button
              className="dt-btn dt-btn--primary"
              disabled={!selected || busy}
              onClick={() => selected && onPick(selected)}
              type="button"
            >
              {busy ? <LoaderCircle aria-hidden="true" size={14} /> : null}
              Use This Folder
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
