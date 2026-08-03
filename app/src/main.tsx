import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from './components/ThemeProvider';
import { ApiContext } from './data/api-context';
import { api } from './data/client';
import { queryClient } from './data/queryClient';
import { HomeModeProvider } from './modules/home/HomeModeProvider';
import { PomodoroProvider } from './modules/pomodoro/PomodoroProvider';
import App from './App';
import '@fontsource-variable/hanken-grotesk/wght.css'; // self-hosted; Vite bundles the .woff2
import './index.css';

// Provider order matters: HomeModeProvider must wrap ThemeProvider (the theme follows the home mode),
// and both need the api/query layer above them (they read settings).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ApiContext value={api}>
        <HomeModeProvider>
          <ThemeProvider>
            <PomodoroProvider>
              <App />
            </PomodoroProvider>
          </ThemeProvider>
        </HomeModeProvider>
      </ApiContext>
    </QueryClientProvider>
  </StrictMode>,
);
