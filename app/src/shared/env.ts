// Centralized Vite env access — components/data never read import.meta.env directly. Phase 12 injects
// VITE_API_MODE=http + VITE_API_BASE at build time; until then the app runs on the stub.
type ApiMode = 'stub' | 'http';

export const API_MODE: ApiMode = import.meta.env.VITE_API_MODE === 'http' ? 'http' : 'stub';
export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

// Cognito (Phase 11) — injected at build time in http mode. AUTHORITY is the user-pool issuer URL
// (https://cognito-idp.<region>.amazonaws.com/<userPoolId>). Empty in stub mode, where auth is bypassed.
export const COGNITO_AUTHORITY: string = (import.meta.env.VITE_COGNITO_AUTHORITY as string | undefined) ?? '';
export const COGNITO_CLIENT_ID: string = (import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined) ?? '';
