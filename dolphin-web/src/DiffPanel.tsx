import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquarePlus, Send, X } from 'lucide-react';
import { useApi } from './apiContext';
import { parseDiff, reviewPrompt, type DiffFile, type DiffLine, type ReviewComment } from './diffModel';
import type { SessionDiff } from './types';
import { panelError, useModalPanel } from './useModalPanel';
import './workflow.css';

/* What a session changed against its base, with a comment box on every line.
   The comments go to the session as one prompt, through the same paste path
   the composer uses, so the agent reads them as a single message. */

const OPEN_LINES = 400;
/** Diff text is untrusted and unbounded: a very long line is cut for display, and files past the cap wait for a click. */
const MAX_LINE_CHARS = 2000;
const FILE_PAGE = 100;

/** A comment, and the diff line it sits under. */
type PanelComment = ReviewComment & { key: string };

function lineLabel(file: DiffFile, line: DiffLine): string {
  return line.kind === 'del' ? `${file.path} removed line ${line.oldLine}` : `${file.path} line ${line.newLine}`;
}

/** `hasAgent`: Codex or Claude runs in the session's active pane. Without one the comments are not sent: a shell would run them as commands. */
export default function DiffPanel({ projectId, sessionName, hasAgent, onClose }: { projectId: string; sessionName: string; hasAgent: boolean; onClose: () => void }) {
  const { fetchSessionDiff, sendTmuxInput } = useApi();
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [error, setError] = useState('');
  const [comments, setComments] = useState<PanelComment[]>([]);
  const [editing, setEditing] = useState<{ key: string; draft: string } | null>(null);
  const [sent, setSent] = useState('');
  const [sending, setSending] = useState(false);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState(FILE_PAGE);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let current = true;
    fetchSessionDiff(projectId, sessionName)
      .then((result) => { if (current) setDiff(result); })
      .catch((reason) => { if (current) setError(panelError(reason)); });
    return () => { current = false; };
  }, [projectId, sessionName]);
  // An open comment box answers Escape itself (it cancels the comment).
  useModalPanel(panel, onClose, { holdEscape: () => editing !== null });
  const files = useMemo(() => (diff ? parseDiff(diff.diff) : []), [diff]);
  const keyOf = (file: DiffFile, line: DiffLine) => `${file.path}:${line.oldLine ?? ''}:${line.newLine ?? ''}`;
  const add = (file: DiffFile, line: DiffLine, text: string) => {
    setComments((list) => [...list, { path: file.path, line: line.newLine ?? line.oldLine, side: line.newLine === null ? 'old' : 'new', code: line.text, text, key: keyOf(file, line) }]);
    setEditing(null);
    setSent('');
  };
  const send = async () => {
    const prompt = reviewPrompt(comments);
    if (!prompt || !hasAgent) return;
    setSending(true);
    setError('');
    try {
      await sendTmuxInput(projectId, sessionName, prompt, { requireAgent: true });
      setComments([]);
      setSent(`Sent to ${sessionName}.`);
    } catch (reason) {
      setError(panelError(reason));
    } finally {
      setSending(false);
    }
  };
  const count = comments.length;
  return (
    <div className="workflow-scrim" role="presentation" onClick={onClose}>
      <div
        ref={panel}
        tabIndex={-1}
        className="workflow-panel workflow-panel--wide"
        role="dialog"
        aria-modal="true"
        aria-label={`Changes in ${sessionName}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="workflow-header">
          <h2>Changes in {sessionName}</h2>
          <small>{diff ? `against ${diff.base_ref} (${diff.base_sha.slice(0, 7)})` : ''}</small>
          <button type="button" className="dt-btn dt-btn--ghost" aria-label="Close" onClick={onClose}><X size={16} aria-hidden="true" /></button>
        </header>
        <div className="workflow-body">
          {!diff && !error && <p role="status">Loading changes…</p>}
          {error && <p role="alert">{error}</p>}
          {diff && !files.length && <p>No changes against {diff.base_ref}.</p>}
          {diff?.truncated && <p className="workflow-note">This is a large diff; only its first part is shown.</p>}
          {diff?.untracked ? <p className="workflow-note">{diff.untracked} new {diff.untracked === 1 ? 'file' : 'files'} not yet tracked by git.</p> : null}
          {diff?.notes?.length ? <ul className="workflow-note" aria-label="Notes on this diff">{diff.notes.map((note, index) => <li key={index}>{note}</li>)}</ul> : null}
          {files.slice(0, shown).map((file) => {
            const size = file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0);
            return (
              <details key={file.path} className="diff-file" open={size <= OPEN_LINES} onToggle={(event) => { const isOpen = event.currentTarget.open; setOpened((list) => (list[file.path] === isOpen ? list : { ...list, [file.path]: isOpen })); }}>
                <summary><span>{file.path}</span><small>{file.status}{file.oldPath ? ` from ${file.oldPath}` : ''}</small></summary>
                {(opened[file.path] ?? size <= OPEN_LINES) && (file.binary ? <p className="workflow-note">Binary file.</p> : file.hunks.map((hunk, hunkIndex) => (
                  <table key={hunkIndex} className="diff-hunk"><tbody>
                    <tr className="diff-hunk-header"><td colSpan={4}>{hunk.header}</td></tr>
                    {hunk.lines.map((line, lineIndex) => {
                      const key = keyOf(file, line);
                      const label = `Comment on ${lineLabel(file, line)}`;
                      return (
                        <Fragment key={lineIndex}>
                          <tr className="diff-line" data-kind={line.kind}>
                            <td className="diff-num">{line.oldLine ?? ''}</td>
                            <td className="diff-num">{line.newLine ?? ''}</td>
                            <td className="diff-code"><code>{line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}{line.text.length > MAX_LINE_CHARS ? `${line.text.slice(0, MAX_LINE_CHARS)}… (${line.text.length - MAX_LINE_CHARS} more characters)` : line.text}</code></td>
                            <td className="diff-act"><button type="button" aria-label={label} title="Comment on this line" onClick={() => setEditing({ key, draft: '' })}><MessageSquarePlus size={13} aria-hidden="true" /></button></td>
                          </tr>
                          {comments.filter((comment) => comment.key === key).map((comment, index) => (
                            <tr key={`comment-${index}`} className="diff-comment-row"><td colSpan={4}><p className="diff-comment">{comment.text}</p></td></tr>
                          ))}
                          {editing?.key === key && (
                            <tr className="diff-comment-row"><td colSpan={4}>
                              <form onSubmit={(event) => { event.preventDefault(); if (editing.draft.trim()) add(file, line, editing.draft.trim()); }}>
                                <textarea
                                  autoFocus
                                  aria-label={label}
                                  value={editing.draft}
                                  onChange={(event) => setEditing({ key, draft: event.target.value })}
                                  onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setEditing(null); } }}
                                />
                                <div>
                                  <button type="submit" className="machine-action" disabled={!editing.draft.trim()}>Add comment</button>
                                  <button type="button" className="dt-btn dt-btn--ghost" onClick={() => setEditing(null)}>Cancel</button>
                                </div>
                              </form>
                            </td></tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody></table>
                )))}
              </details>
            );
          })}
          {files.length > shown && <button type="button" className="machine-action" onClick={() => setShown((count) => count + FILE_PAGE)}>{`Show ${Math.min(FILE_PAGE, files.length - shown)} more of ${files.length - shown} files`}</button>}
        </div>
        <footer className="workflow-footer">
          {sent && <span role="status">{sent}</span>}
          <span>{count ? `${count} ${count === 1 ? 'comment' : 'comments'}` : 'Comment on any line to ask for a change.'}</span>
          {!hasAgent && <span className="workflow-note">Start Claude or Codex in this session to send comments.</span>}
          <button type="button" className="machine-action" disabled={!count || sending || !hasAgent} onClick={() => void send()}>
            <Send size={13} aria-hidden="true" /> {`Send ${count} ${count === 1 ? 'comment' : 'comments'} to ${sessionName}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
