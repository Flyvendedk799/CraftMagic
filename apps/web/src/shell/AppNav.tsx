/**
 * The bar every signed-in page wears.
 *
 * Before this existed each route was an island: the editor knew about `/mod` and `/status`,
 * the library knew about the editor, and nothing knew about anything else. That is fine for a
 * demo reached by one link and wrong for a product someone comes back to — the way around a
 * tool should not depend on which door you came in through.
 *
 * So: one component, one place that decides what the destinations are. Rendered by the
 * dashboard, the library and the mod page. Deliberately *not* by the editor or the guide —
 * the editor is a full-viewport canvas with its own floating HUD, and the guide is a document
 * that gets printed. Both link back here instead.
 *
 * The account chip is the other half of its job. Signed in, generation is metered per account
 * and per day, and that number decides whether the prompt box will work at all; putting it in
 * the chrome means the answer is already on screen when the question comes up, rather than
 * being discovered at the moment of a refusal.
 */

import { NavLink, Link } from 'react-router-dom';
import { Logo } from '../brand/Logo.js';
import { logout, useAuth } from '../library/auth.js';
import './shell.css';

export interface AppNavProps {
  /**
   * Marks the current page for the "you are here" state.
   *
   * Passed in rather than read from the router because two of these routes are reached with a
   * query the other one also accepts — `/dashboard?signup=1` and `/library?signup=1` — and a
   * path comparison would be quietly wrong the day another such pair appears.
   */
  current?: 'dashboard' | 'library' | 'mod';
}

interface Destination {
  key: NonNullable<AppNavProps['current']> | 'editor' | 'layouter';
  to: string;
  label: string;
  /** Signed-out visitors get the tour, not the filing cabinet. */
  requiresAccount: boolean;
}

const DESTINATIONS: Destination[] = [
  {
    key: 'dashboard',
    to: '/dashboard',
    label: 'Dashboard',
    requiresAccount: false,
  },
  { key: 'editor', to: '/editor', label: 'Editor', requiresAccount: false },
  // Two ways to make the same thing, so they sit next to each other: blocks in the editor,
  // rooms in the layouter. Neither needs an account, and both end at the same exports.
  { key: 'layouter', to: '/layouter', label: 'Layouter', requiresAccount: false },
  { key: 'library', to: '/library', label: 'Library', requiresAccount: true },
  { key: 'mod', to: '/mod', label: 'Minecraft mod', requiresAccount: false },
];

export function AppNav({ current }: AppNavProps) {
  const auth = useAuth();
  const account = auth.status === 'signedIn' ? auth.account : null;

  return (
    <header className="nav">
      <div className="nav__inner">
        {/* Home is the dashboard once there is an account behind it, and the landing page
            before — the marketing pitch is not what a returning user wants from the logo. */}
        <Link className="nav__brand" to={account ? '/dashboard' : '/'} aria-label="CraftMagic home">
          <Logo size={28} />
        </Link>

        <nav className="nav__links" aria-label="Sections">
          {DESTINATIONS.filter((destination) => account || !destination.requiresAccount).map(
            (destination) => (
              <NavLink
                key={destination.key}
                className="nav__link"
                to={destination.to}
                aria-current={current === destination.key ? 'page' : undefined}
              >
                {destination.label}
              </NavLink>
            ),
          )}
          {account?.isAdmin && (
            <NavLink className="nav__link" to="/admin">
              Settings
            </NavLink>
          )}
        </nav>

        {account ? (
          <div className="nav__account">
            <QuotaPill left={account.generationsLeftToday} quota={account.dailyGenQuota} />
            <span className="nav__email" title={account.email}>
              {account.email}
            </span>
            <button type="button" className="nav__signout" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        ) : (
          <div className="nav__account">
            {/* `loading` renders as signed out rather than as a spinner: the session check is
                one request against a cookie, and a flashing placeholder in the chrome of every
                page is more disruptive than a link that settles a moment later. */}
            <Link className="nav__link" to="/dashboard">
              Sign in
            </Link>
            <Link className="nav__cta" to="/dashboard?signup=1">
              Sign up free
            </Link>
          </div>
        )}
      </div>
    </header>
  );
}

/**
 * Generations left today, as a number and a bar.
 *
 * The bar is the part that carries at a glance — "12" means nothing without knowing the
 * allowance, and nobody reads "12 of 30" in passing. It turns amber at a third left and coral
 * at empty, which is the point where the prompt box stops working and the user deserves to
 * have seen it coming.
 */
function QuotaPill({ left, quota }: { left: number; quota: number }) {
  const fraction = quota > 0 ? Math.max(0, Math.min(1, left / quota)) : 0;
  const level = left === 0 ? 'empty' : fraction <= 1 / 3 ? 'low' : 'ok';

  return (
    <Link
      className="nav__quota"
      to="/dashboard"
      data-level={level}
      title={`${left} of ${quota} generations left today`}
    >
      <span className="nav__quota-bar" aria-hidden="true">
        <span style={{ width: `${Math.round(fraction * 100)}%` }} />
      </span>
      <span className="nav__quota-text">
        {left}
        <span className="nav__quota-quota">/{quota}</span>
      </span>
    </Link>
  );
}
