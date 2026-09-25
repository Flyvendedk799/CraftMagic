# CraftMagic Studio: test findings and plan

Implemented on `cursor/studio-project-zoom-0047`. The journey the plan describes — one project, zoom in and out, edits that follow the placement — is wired through the existing world, build and plan documents rather than a new table. Placements already point at a library row; editing that row now writes back to it.

## Phase 1

- [x] Warn before leaving the studio with unsaved work, and show an Unsaved mark in the header.
- [x] Keep each mode's undo stack across a mode switch (the stack used to die with the page).
- [x] Opening Build from a floorplan compiles the plan, the same as Hand off, instead of the empty 32×24×32 plot.
- [x] On the map, a build left in the address bar offers "Place this build on the map" instead of only saying it is not open.
- [x] A dragged line commits as one line. Grab's click selects that one block; dragging still moves it. Ctrl+Y is on the shortcut sheet.
- [x] A room drag that fails says why, including when neighbour-snapping shrinks it below 3×3. Unreachable-room warnings name the storey and are not repeated for the same room.
- [x] A program whose components stick out of `size` grows the volume and says so, instead of dropping the blocks.
- [x] The component shelf is All / Structures / Interiors, one choice, with an empty state that says which kind is missing.

## Phase 2

- [x] The header is a breadcrumb (map, structure, plan) instead of three peer mode buttons.
- [x] Double-click a placed building to open its blocks. The placement points at the library row, and edits to a `lib:` build are written back to that row.
- [x] `POST /api/builds` with an `id` updates that row (voxels, program, edits, plan) instead of inserting a copy.
- [x] A single undo stack that crosses zoom levels. Ctrl+Z undoes the latest edit in the project, zooming to the document that owns it when that document is not the one open.
- [x] Recompiling a plan onto the same structure while keeping hand edits as an override, with an explicit Detach. A library plan stays on `?plan=lib:`; Detach clears that link.
- [x] Starting a plan on a chosen plot with the surrounding terrain in the 3D preview. The placement inspector’s “Draw a plan here” carries the view into Plan.

## Phase 3

- [x] Water, Forest, Desert, Swamp and Peaks are paint grounds. Water lowers the column under sea level so the existing water fill shows.
- [x] The 3D view's cell budget is 16 million, and a trimmed view says the rest did not fit in memory.
- [x] Dragging a placement snaps to a 4-block grid.
- [x] Sending the whole map asks first and says it can take hours. The on-screen export is still the view.
- [x] Dashboard "Start a build" opens the map with one plot selected.
- [x] Streaming every requested region instead of shrinking the rectangle to the budget. The request is tiled into windows that each fit, and the 3D view walks them.
- [x] Spacing guides and a path from a door to a road. The inspector names the gap to the nearest placement, and Path to road paints a path stratum from the door edge.
