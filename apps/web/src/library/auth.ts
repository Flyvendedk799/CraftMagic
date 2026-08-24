/**
 * Who is signed in, shared across the whole app.
 *
 * A module-level store with `useSyncExternalStore` rather than a context provider. Two
 * unrelated places need this — the account panel in the editor HUD and the library page — and
 * they are on different routes, so a provider would have to wrap the router and every
 * consumer would still get the same value. This is the same amount of state with none of the
 * plumbing, and it means signing in on one route is already true on the other.
 *
 * Nothing here holds a token. The session cookie is `HttpOnly`, so the browser attaches it
 * and JavaScript cannot read it — which is the point: an XSS bug can make requests as the
 * user, but it cannot walk off with a 30-day credential.
 */

import { useSyncExternalStore } from 'react';

export interface Account {
  id: string;
  email: string;
  dailyGenQuota: number;
  generationsUsedToday: number;
  generationsLeftToday: number;
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'signedIn'; account: Account };

const listeners = new Set<() => void>();
let state: AuthState = { status: 'loading' };

function set(next: AuthState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The snapshot must be reference-stable between changes or `useSyncExternalStore` re-renders
 * forever, which is why `state` is replaced rather than rebuilt on read.
 */
function snapshot(): AuthState {
  return state;
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

/** Reads the current session. Safe to call repeatedly; the first call is the one that matters. */
export async function refreshAccount(): Promise<void> {
  try {
    const response = await fetch('/api/me');
    if (!response.ok) {
      set({ status: 'anonymous' });
      return;
    }
    const body = (await response.json()) as { user: Account };
    set({ status: 'signedIn', account: body.user });
  } catch {
    // An unreachable server is indistinguishable from being signed out, and treating it as
    // such keeps the editor usable rather than stuck on a spinner.
    set({ status: 'anonymous' });
  }
}

export interface AuthError {
  error: string;
  message: string;
}

async function authenticate(path: string, email: string, password: string): Promise<AuthError | null> {
  const response = await post(path, { email, password });
  const body = (await response.json().catch(() => ({}))) as Partial<AuthError> & { user?: Account };

  if (!response.ok) {
    return {
      error: body.error ?? 'failed',
      message: body.message ?? `Something went wrong (HTTP ${response.status}).`,
    };
  }

  if (body.user) set({ status: 'signedIn', account: body.user });
  return null;
}

export function register(email: string, password: string): Promise<AuthError | null> {
  return authenticate('/api/auth/register', email, password);
}

export function login(email: string, password: string): Promise<AuthError | null> {
  return authenticate('/api/auth/login', email, password);
}

export async function logout(): Promise<void> {
  await post('/api/auth/logout').catch(() => undefined);
  // Set unconditionally: the server clears the cookie even when it does not recognise the
  // session, so a failed request still means this browser is signed out.
  set({ status: 'anonymous' });
}

/** Called by consumers on mount; only the first one actually fetches. */
let started = false;
export function ensureLoaded(): void {
  if (started) return;
  started = true;
  void refreshAccount();
}

export function useAuth(): AuthState {
  ensureLoaded();
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
