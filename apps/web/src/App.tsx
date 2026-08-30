import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AdminPage } from './admin/AdminPage.js';
import { EditorPage } from './editor/EditorPage.js';
import { GuidePage } from './guide/GuidePage.js';
import { LibraryPage } from './library/LibraryPage.js';
import { ModPage } from './mod/ModPage.js';
import { PlanPage } from './plan/PlanPage.js';
import { StatusPage } from './StatusPage.js';

/**
 * Four routes, all load-bearing. `/status` keeps the M0 API and WebSocket round-trips
 * reachable — they are the deployment smoke test, not a placeholder page, and the server's
 * SPA fallback means the deep link survives a hard refresh behind the reverse proxy.
 *
 * `/guide` takes the same `?build=&p.<name>=` query as the editor, so a booklet is just the
 * current view with a different path: no export step, no server round trip, and a link
 * someone can send that prints the same build at the same size.
 *
 * `/library` opens a saved build the same way, with `?build=lib:<id>` — a library build is
 * not a separate kind of thing in the editor, only one that has to be fetched first.
 *
 * `/mod` is where "Send to game" sends anyone who does not have the mod yet. Without it the
 * pairing instructions name a command that cannot exist on their machine.
 *
 * `/plan` arranges several saved builds on one plot. It shares the editor's whole frame and
 * composes down to an ordinary `VoxelGrid`, so it needs no route of its own on the server and
 * nothing downstream — export, save, send to game — knows a plan from a build.
 */
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<EditorPage />} />
        <Route path="/plan" element={<PlanPage />} />
        <Route path="/guide" element={<GuidePage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/mod" element={<ModPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/status" element={<StatusPage />} />
      </Routes>
    </BrowserRouter>
  );
}
