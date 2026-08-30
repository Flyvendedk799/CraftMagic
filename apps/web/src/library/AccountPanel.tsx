/**
 * Sign in, sign up, sign out.
 *
 * A utility surface, not a landing page: it opens only when asked for, and closes itself once
 * it has done its job. Signed out is a supported state throughout the app — the editor and
 * "send to game" both work without an account — so this never blocks anything. It says what
 * an account *adds*, which is builds that are still there tomorrow.
 *
 * Two shapes, one component. The library page wants a **panel**: a block in the document with
 * the form laid out in it. The studio's title bar wants a **menu**: a chip showing who you
 * are, with the same form in a popover under it. They are the same states and the same
 * submit, so splitting them into two components would have meant maintaining the "is the
 * password cleared on success" question twice.
 *
 * The root element keeps `.account` and `data-state` in both shapes: it is how the deployment
 * drivers check whether a session took, and a signed-in studio must be able to answer that
 * without opening anything.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { login, logout, register, useAuth } from './auth.js';
import './library.css';

export interface AccountPanelProps {
  /** Shown when signed out, above the form's trigger. */
  invitation?: string;
  /** The library page opens expanded; the studio's chip starts closed. */
  initiallyOpen?: boolean;
  /** `panel` sits in the page flow; `menu` is a chip with a popover. */
  variant?: 'panel' | 'menu';
}

type Mode = 'login' | 'register';

export function AccountPanel({
  invitation,
  initiallyOpen = false,
  variant = 'panel',
}: AccountPanelProps) {
  const auth = useAuth();
  const [open, setOpen] = useState(initiallyOpen);
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);

  const menu = variant === 'menu';

  // A popover that ignores Escape and outside clicks is a popover people learn to distrust.
  // Panels are part of the page and must not close from either.
  useEffect(() => {
    if (!menu || !open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [menu, open]);

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

  const className = `account${menu ? ' account--menu' : ''}`;

  if (auth.status === 'loading') {
    return (
      <div className={className} data-state="loading" ref={root}>
        <p className="account__note">Checking your session…</p>
      </div>
    );
  }

  if (auth.status === 'signedIn') {
    const { account } = auth;
    const left = account.generationsLeftToday;

    if (menu) {
      return (
        <div className={className} data-state="signed-in" ref={root}>
          <button
            type="button"
            className="account__chip"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            title={account.email}
          >
            <span className="account__avatar" aria-hidden="true">
              {account.email.slice(0, 1).toUpperCase()}
            </span>
            {/* The quota is the number people actually come here to check, so it rides on
                the chip rather than hiding one click away inside the menu. */}
            <span className="account__quota" data-empty={left === 0}>
              {left}/{account.dailyGenQuota}
            </span>
          </button>

          {open && (
            <div className="account__pop" role="menu">
              <p className="account__who">
                <span className="account__email" title={account.email}>
                  {account.email}
                </span>
              </p>
              <p className="account__note">
                {left} of {account.dailyGenQuota} generations left today
              </p>
              <button type="button" className="account__signout" onClick={() => void logout()}>
                Sign out
              </button>
            </div>
          )}
        </div>
      );
    }

    return (
      <div className={className} data-state="signed-in" ref={root}>
        <p className="account__who">
          <span className="account__email" title={account.email}>
            {account.email}
          </span>
          <button type="button" className="account__link" onClick={() => void logout()}>
            Sign out
          </button>
        </p>
        <p className="account__note">
          {left} of {account.dailyGenQuota} generations left today
        </p>
      </div>
    );
  }

  const form = (
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
  );

  if (menu) {
    return (
      <div className={className} data-state="anonymous" ref={root}>
        <button
          type="button"
          className="account__chip account__chip--anon"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          Sign in
        </button>
        {open && (
          <div className="account__pop">
            {invitation && <p className="account__note">{invitation}</p>}
            {form}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={className} data-state="anonymous" ref={root}>
      {/* Outside the collapsed branch: the invitation is the reason to have an account and the
          form is only the mechanism, so it stays on screen while the form is open. */}
      {invitation && <p className="account__note">{invitation}</p>}

      {!open && (
        <button type="button" className="account__open" onClick={() => setOpen(true)}>
          Sign in or create an account
        </button>
      )}

      {open && form}
    </div>
  );
}
