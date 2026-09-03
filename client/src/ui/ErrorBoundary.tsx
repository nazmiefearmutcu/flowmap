/**
 * Root error boundary. An uncaught throw inside a mount effect (or any render)
 * unmounts React's entire tree — the user sees a bare background-color void
 * with no message, no way out (F1 in the 2026-09-03 UI review). This boundary
 * guarantees the failure is at least LEGIBLE: what broke, and a reload action.
 *
 * It is deliberately NOT a render-crash zoo keeper for individual panels — a
 * panel-level boundary that re-renders into a broken frame does more harm than
 * good. One boundary at the root, converting "blank screen" into "error card".
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the failure on the console for anyone with devtools open; the UI
    // below is the user-facing half of the report.
    console.error('[flowmap] unrecoverable UI error', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="app-crash" role="alert" data-testid="app-crash">
        <span className="app-crash__title">FlowMap hit an unrecoverable error</span>
        <pre className="app-crash__detail">{error.message}</pre>
        <button type="button" className="app-crash__reload" onClick={() => window.location.reload()}>
          Reload FlowMap
        </button>
      </div>
    );
  }
}
