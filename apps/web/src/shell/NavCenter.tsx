/**
 * A slot in the middle of the app bar, filled by whoever mounts the page.
 *
 * The studio's mode switch is the reason this exists. It belongs to the shell — `StudioPage`
 * decides which of Build, Architecture and World is mounted, and the pill is how you say so —
 * but the bar it wants to sit in is rendered by each *page*, one level down. So it was drawn
 * as a fixed overlay pinned to the top of the viewport, and a fixed overlay has no idea what
 * is underneath it: it sat on Architecture's zoom bar, on World's toolbar, and on the top of
 * the editor's canvas. Nudging it up into the bar's own row only moved the collision onto the
 * navigation links.
 *
 * A context turns it into an ordinary flex child of the bar instead, so the browser does the
 * arithmetic and the pill can never land on top of anything. The shell provides, `AppNav`
 * renders, and a page that is not in the studio provides nothing and gets a bar with a gap in
 * the middle exactly as before.
 */

import { createContext, useContext, type ReactNode } from 'react';

const NavCenterContext = createContext<ReactNode>(null);

export function NavCenterProvider({ node, children }: { node: ReactNode; children: ReactNode }) {
  return <NavCenterContext.Provider value={node}>{children}</NavCenterContext.Provider>;
}

/** What the app bar should render between its links and its account chip, if anything. */
export function useNavCenter(): ReactNode {
  return useContext(NavCenterContext);
}
