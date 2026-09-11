import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import './ui/theme.css';
import './theme/themes.css'; // lane CE: theme blocks (AFTER ui/theme.css)
import './App.css';

import { initLocale } from './i18n';
import { initTheme } from './theme';
import { loadSettings } from './ui/settings';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('FlowMap: #root element not found');
}

// Boot seeders (lane CE): stamp the persisted theme onto <html data-theme> and
// restore the persisted locale BEFORE the first render, so the shell paints in
// the user's theme/language and never flashes the default. Idempotent.
initTheme();
initLocale();

// R1-L1: stamp the persisted colormap on <html data-chart-ramp> BEFORE the
// first paint. The App effect (App.tsx) keeps it in sync for later changes;
// doing it here too means a stored legacy family pins the dark chart tokens
// from frame one instead of flashing the light theme mirror first.
document.documentElement.dataset.chartRamp = loadSettings(
  typeof window !== 'undefined' ? window.localStorage : null,
).colormap;

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
