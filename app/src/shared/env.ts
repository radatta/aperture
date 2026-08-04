// Centralized Vite env access — components/data never read import.meta.env directly. Phase 12 injects
// VITE_API_MODE=http + VITE_API_BASE at build time; until then the app runs on the stub.
type ApiMode = 'stub' | 'http';

export const API_MODE: ApiMode = import.meta.env.VITE_API_MODE === 'http' ? 'http' : 'stub';
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
