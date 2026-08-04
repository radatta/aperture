import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from './auth/AuthProvider';
import { RequireAuth } from './auth/RequireAuth';
import { ThemeProvider } from './components/ThemeProvider';
import { ApiContext } from './data/api-context';
import { api } from './data/client';
import { queryClient } from './data/queryClient';
import { HomeModeProvider } from './modules/home/HomeModeProvider';
import { PomodoroProvider } from './modules/pomodoro/PomodoroProvider';
import App from './App';
import '@fontsource-variable/hanken-grotesk/wght.css'; // self-hosted; Vite bundles the .woff2
import './index.css';

// AuthProvider is outermost and RequireAuth gates everything below it, so the data providers (which
// fire scoped queries) only mount once there's an identity — and in http mode the token is set before
// they do. Below that, HomeModeProvider must wrap ThemeProvider (the theme follows the home mode).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RequireAuth>
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
      </RequireAuth>
    </AuthProvider>
  </StrictMode>,
);
