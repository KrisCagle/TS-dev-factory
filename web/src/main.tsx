import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PrefsProvider } from './prefs';
import { FactoryProvider } from './state';
import { HarvestProvider } from './harvest';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PrefsProvider>
      <FactoryProvider>
        <HarvestProvider>
          <App />
        </HarvestProvider>
      </FactoryProvider>
    </PrefsProvider>
  </StrictMode>,
);
