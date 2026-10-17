/**
 * The browser tab title for a given route.
 *
 * The specific part leads and the app name trails, because a tab strip
 * truncates from the right: with several Dolphin tabs open, a title starting
 * "Dolphin Tasks — " is thirteen identical characters before anything that
 * tells them apart. The project name is the thing worth reading, so it goes
 * first.
 *
 * Kept pure and separate from App.tsx so every route's title is asserted in
 * one place. Only mutually exclusive App.tsx / GlassWorkspace.tsx / GlassHealthPage.tsx route roots assign `document.title`,
 * which `documentTitle.test.ts` enforces against the source. SystemHealthView
 * used to assign it too, in a third format. That was invisible to behavioural
 * tests — React flushes child effects before parent ones, so App's assignment
 * always landed last — but the health view's effect re-runs when its polling
 * callbacks change identity, and that re-run would have overwritten the tab
 * title long after App had settled it.
 */

export type TitleView =
  | 'control-center'
  | 'project'
  | 'health'
  | 'improvement-radar';

export type TitleContext = {
  view: TitleView;
  /** Null while the project list is still loading, or if the id is unknown. */
  projectName: string | null;
  /** The active terminal leads cockpit titles so browser tabs remain distinct. */
  sessionName?: string | null;
};

export const APP_TITLE = 'Dolphin Tasks';

const SEPARATOR = ' — ';
const SURFACE_SEPARATOR = ' · ';

const VIEW_LABELS: Record<Exclude<TitleView, 'project'>, string> = {
  'control-center': 'Control Center',
  health: 'System Health',
  'improvement-radar': 'Morning Radar',
};

function suffixed(lead: string): string {
  return `${lead}${SEPARATOR}${APP_TITLE}`;
}

export function documentTitleFor(context: TitleContext): string {
  if (context.view !== 'project') {
    return suffixed(VIEW_LABELS[context.view]);
  }

  /* A cold load renders the project route before /api/projects answers. The
     bare app title is what index.html already shows, so this returns the
     unchanged string rather than a placeholder that would flash. */
  if (!context.projectName) return APP_TITLE;

  const lead = context.sessionName
    ? `${context.sessionName}${SURFACE_SEPARATOR}${context.projectName}`
    : context.projectName;
  return suffixed(lead);
}

/** The glass workspace's title: the active session, led by its program's own
    OSC title when it set one (assigned only by GlassWorkspace.tsx). */
export function glassDocumentTitle(
  active: { projectName: string; sessionName: string } | null,
  terminalTitle = '',
): string {
  if (!active) return 'Dolphin — Workspace';
  const lead = terminalTitle && terminalTitle !== active.sessionName
    ? `${terminalTitle}${SURFACE_SEPARATOR}${active.sessionName}`
    : active.sessionName;
  return `${lead}${SURFACE_SEPARATOR}${active.projectName} — Dolphin`;
}
