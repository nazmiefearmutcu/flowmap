import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import './ui/theme.css';
import './theme/themes.css'; // lane CE: theme blocks (AFTER ui/theme.css)
import './App.css';

import { initLocale } from './i18n';
import { initTheme } from './theme';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('FlowMap: #root element not found');
}

// Boot seeders (lane CE): stamp the persisted theme onto <html data-theme> and
// restore the persisted locale BEFORE the first render, so the shell paints in
// the user's theme/language and never flashes the default. Idempotent.
initTheme();
initLocale();

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
