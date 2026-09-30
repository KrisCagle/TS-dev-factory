import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PrefsProvider } from './prefs';
import { FactoryProvider } from './state';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrefsProvider>
      <FactoryProvider>
        <App />
      </FactoryProvider>
    </PrefsProvider>
  </StrictMode>,
);
