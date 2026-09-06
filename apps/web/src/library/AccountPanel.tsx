/**
 * Sign in, sign up, sign out.
 *
 * A utility surface, not a landing page: it lives inside an existing dark panel, opens only
 * when asked for, and closes itself once it has done its job. Signed out is a supported state
 * for everything that runs in the browser — the samples, the editing tools, the `.schem` and
 * program downloads and the printable guide — so this never blocks any of that. What it must
 * not do is imply more: generation, the library, pairing Minecraft and sending a build all
 * need an account (see the ownership policy in the server's `auth/routes.ts`), and for a long
 * time this file's own header claimed the opposite. The line below is the honest version, and
 * it is on screen *before* the 401 rather than left for the console.
 */

import { useCallback, useState } from 'react';
import { login, logout, register, useAuth } from './auth.js';
import './library.css';

export interface AccountPanelProps {
  /** Shown when signed out, above the form's trigger. */
  invitation?: string;
  /** The library page opens expanded; the editor HUD starts collapsed. */
  initiallyOpen?: boolean;
  /**
   * Which tab to open on. Defaults to signing in, which is right for someone who came back to
   * their own library — but the landing page's buttons all say "sign up", and landing a new
   * visitor on a sign-in form asks them for a password they have not chosen yet.
   */
  initialMode?: Mode;
}

type Mode = 'login' | 'register';

/**
 * What an account is for, said once and truthfully.
 *
 * Shown wherever a caller does not supply its own invitation. It draws the same line the
 * server draws: everything in the browser is free to use, everything that owns server state,
 * spends money or reaches a Minecraft world needs to belong to someone.
 */
export const ACCOUNT_LINE =
  'Samples, editing, the schematic download and the printed guide work without an account. ' +
  'Generating, saving to the library, pairing Minecraft and sending a build need one.';

export function AccountPanel({
  invitation,
  initiallyOpen = false,
  initialMode = 'login',
}: AccountPanelProps) {
  const auth = useAuth();
  const [open, setOpen] = useState(initiallyOpen);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const failure = await (mode === 'register' ? register : login)(email, password);
        if (failure) {
          setError(failure.message);
          return;
        }
        // Cleared on success rather than left in the DOM: there is no reason for a password
        // to outlive the request that used it, even in a React state slot.
        setPassword('');
        setOpen(false);
      } finally {
        setBusy(false);
      }
    },
    [busy, mode, email, password],
  );

  if (auth.status === 'loading') {
    return (
      <div className="account" data-state="loading">
        <p className="account__note">Checking your session…</p>
      </div>
    );
  }

  if (auth.status === 'signedIn') {
    const { account } = auth;
    return (
      <div className="account" data-state="signed-in">
        <p className="account__who">
          <span className="account__email" title={account.email}>
            {account.email}
          </span>
          <button type="button" className="account__link" onClick={() => void logout()}>
            Sign out
          </button>
        </p>
        <p className="account__note">
          {account.generationsLeftToday} of {account.dailyGenQuota} generations left today
        </p>
      </div>
    );
  }

  return (
    <div className="account" data-state="anonymous">
      {/* Outside the collapsed branch: the invitation is the reason to have an account and the
          form is only the mechanism, so it stays on screen while the form is open. A caller
          with nothing particular to say gets the honest default rather than nothing. */}
      <p className="account__note">{invitation ?? ACCOUNT_LINE}</p>

      {!open && (
        <button type="button" className="account__open" onClick={() => setOpen(true)}>
          Sign in or create an account
        </button>
      )}

      {open && (
        <form className="account__form" onSubmit={(event) => void submit(event)}>
          <div className="account__tabs">
            <button
              type="button"
              className="account__tab"
              aria-pressed={mode === 'login'}
              onClick={() => {
                setMode('login');
                setError(null);
              }}
            >
              Sign in
            </button>
            <button
              type="button"
              className="account__tab"
              aria-pressed={mode === 'register'}
              onClick={() => {
                setMode('register');
                setError(null);
              }}
            >
              Create account
            </button>
          </div>

          <input
            className="account__input"
            type="email"
            name="email"
            autoComplete="email"
            placeholder="you@example.com"
            aria-label="Email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <input
            className="account__input"
            type="password"
            name="password"
            // Tells the password manager which of the two this is, so signing in does not
            // offer to save a new entry and signing up does not autofill an old one.
            autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            placeholder={mode === 'register' ? 'at least 10 characters' : 'password'}
            aria-label="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />

          <div className="account__actions">
            <button type="submit" className="account__submit" disabled={busy}>
              {busy ? 'Working…' : mode === 'register' ? 'Create account' : 'Sign in'}
            </button>
            {!initiallyOpen && (
              <button type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
            )}
          </div>

          {error && (
            <p className="account__error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
