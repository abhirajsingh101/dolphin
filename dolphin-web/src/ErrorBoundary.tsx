/* Render-crash containment.

   Every async failure path in this app already routes through `setError` and
   lands in the `.error-banner`. What had no handler at all was a *synchronous*
   throw during render: React unmounts the whole tree on an uncaught render
   error, so one bad access inside KanbanControlCenter (3,991 lines) took down
   every surface at once — including a terminal the user was mid-session in,
   with no way back short of a reload.

   Boundaries are per-surface for exactly that reason. A crash in Health, Files,
   or the board must not reach the cockpit, and vice versa. The root boundary in
   main.tsx is the last resort for a throw in the shell itself.

   This must be a class component: getDerivedStateFromError / componentDidCatch
   have no hooks equivalent. */

import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  /** Surface name shown in the fallback, e.g. "the board". Keep it a noun
      phrase that reads inside "Something broke in {label}." */
  label: string;
  children: ReactNode;
  /** Bumping this resets a crashed boundary — pass the value that identifies
      what is being rendered (a project id, a route) so navigating away from a
      surface that crashed on one input clears it automatically. */
  resetKey?: string | number;
};

type State = { error: Error | null };

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(previous: Props): void {
    // Navigating to different content clears a crash caused by the old input.
    // Without this the boundary stays latched and the surface reads as broken
    // forever, even though the thing that threw is no longer on screen.
    if (
      this.state.error !== null &&
      previous.resetKey !== this.props.resetKey
    ) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The browser console is the only sink the frontend has today. Keep the
    // component stack — it is the part that says *which* component threw, and
    // it is not recoverable from the error object alone.
    console.error(`[dolphin] render crash in ${this.props.label}`, error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div className="crash-panel" role="alert">
        <div className="crash-panel-body">
          <strong>Something broke in {this.props.label}.</strong>
          <p>
            The rest of Dolphin is still running — other surfaces and your tmux
            sessions are unaffected.
          </p>
          <pre className="crash-panel-detail">{error.message || String(error)}</pre>
          <div className="crash-panel-actions">
            <button
              className="dt-btn dt-btn--primary"
              type="button"
              onClick={this.handleRetry}
            >
              Try again
            </button>
            <button
              className="dt-btn dt-btn--secondary"
              type="button"
              onClick={() => window.location.reload()}
            >
              Reload Dolphin
            </button>
          </div>
        </div>
      </div>
    );
  }
}
