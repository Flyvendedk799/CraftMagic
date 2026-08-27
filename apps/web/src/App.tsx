import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AdminPage } from './admin/AdminPage.js';
import { DashboardPage } from './dashboard/DashboardPage.js';
import { EditorPage } from './editor/EditorPage.js';
import { GuidePage } from './guide/GuidePage.js';
import { LandingPage } from './landing/LandingPage.js';
import { LayouterPage } from './layouter/LayouterPage.js';
import { LibraryPage } from './library/LibraryPage.js';
import { ModPage } from './mod/ModPage.js';
import { StatusPage } from './StatusPage.js';

/**
 * Routes, all load-bearing. `/status` keeps the M0 API and WebSocket round-trips reachable —
 * they are the deployment smoke test, not a placeholder page, and the server's SPA fallback
 * means the deep link survives a hard refresh behind the reverse proxy.
 *
 * `/` is the landing page and `/editor` is the editor. It used to be the other way round,
 * which was right while the only visitors were people who already knew what this was.
 *
 * `/guide` takes the same `?build=&p.<name>=` query as the editor, so a booklet is just the
 * current view with a different path: no export step, no server round trip, and a link
 * someone can send that prints the same build at the same size.
 *
 * `/library` opens a saved build the same way, with `?build=lib:<id>` — a library build is
 * not a separate kind of thing in the editor, only one that has to be fetched first.
 *
 * `/dashboard` is home for anyone with an account, and the sign-in door for anyone without.
 * Every other route reaches exactly one part of the product, and until this existed nothing
 * showed how those parts join up. `?signup=1` opens its account form on the sign-up tab.
 *
 * `/mod` is where "Send to game" sends anyone who does not have the mod yet. Without it the
 * pairing instructions name a command that cannot exist on their machine.
 *
 * `/layouter` is the editor's counterpart for interiors: a floorplan tool that compiles to the
 * same `BuildProgram` and therefore reaches the same exports. It takes no query at all — a
 * plan lives in the browser rather than in the URL, because a floorplan is far too big to put
 * in a link and, unlike a build, it is a document someone keeps working on.
 */
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/editor" element={<EditorPage />} />
        <Route path="/layouter" element={<LayouterPage />} />
        <Route path="/guide" element={<GuidePage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/mod" element={<ModPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/status" element={<StatusPage />} />
      </Routes>
    </BrowserRouter>
  );
}

/**
 * The landing page — unless the URL is carrying a build, in which case it is the editor.
 *
 * Every build link shared before the editor moved has the shape `/?build=…&p.floors=2`, and
 * those links are the product's main way of spreading. Sending them to a marketing page would
 * break each one silently: the visitor lands somewhere plausible, so nobody reports it.
 *
 * Keyed off any query at all rather than `build` specifically, because `?p.<name>=` and
 * `?s.<axis>=` are meaningful on their own — they open the default build at a chosen size.
 * A bare `/` has no query and is the only thing that reaches the landing page.
 */
function Home() {
  const { search } = useLocation();
  if (search.length > 1) return <Navigate replace to={{ pathname: '/editor', search }} />;
  return <LandingPage />;
}
