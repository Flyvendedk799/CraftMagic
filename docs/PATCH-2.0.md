# Patch 2.0 — the editor, Architecture mode and generation engine, taken up a level

This document is the working record of the 2.0 upgrade: what shipped on this branch, and the
remainder of the approved roadmap for follow-up work.

## Shipped in this patch

**The face (what a first visit sees):**
- **Enhanced rendering is the default look**: lit flat-shaded materials with per-voxel
  procedural grain (no game assets redistributed), a sky gradient, distance fog, ACES
  tonemapping. Classic (the old flat look) is one click away and persisted.
- **Builds assemble**: every build rises layer by layer when opened, and during an AI
  generation the structure now assembles **live** as the model emits it — the streaming tool
  JSON is parsed into partial programs server-side (`partialProgram`), carried on the SSE
  progress events, and expanded into a ghost build in the canvas.
- **Restyle**: five curated material packs (Nordic, Desert, Gothic, Blossom, Ocean) rewrite
  any program's semantic palette shape-aware (stairs stay stairs, so roofs stay pitched).
  Rides in the URL as `?style=<id>`; the guide prints the restyled materials.
- Screenshot button, orthographic projection toggle, WASD/QE flight.

**Editor control:**
- **The detach model is dead.** Hand edits live in an `EditOverlay` (absolute positions +
  canonical block refs) that composites over every re-expansion: param sliders, resize,
  restyle and AI refine all keep working on a hand-edited build. Edits autosave (localStorage
  for generated builds), persist to the library beside the program (migration 005), and old
  detached saves upgrade lazily by diffing.
- **The outliner**: every component as a named row (same naming as the printed guide) —
  click to frame, hover to outline, eye to hide (a real re-expand), solo.
- Selection verbs: Cut, rotate 90° in place, mirror X/Z in place; clipboard mirror on both
  axes; `.schem` import (full Sponge v2 reader) and program-JSON import.

**Architecture control:**
- **Refine with AI**: the drawn plan, compiled, goes through the server's refine pipeline —
  "add window boxes and a chimney" on top of what you drew. The plan stays untouched.
- **Per-storey heights** (a double-height hall under bedrooms), roof **pitch** and
  **overhang** controls, windows that are carved-and-framed (sheet of glass, sill, lintel)
  instead of solid glass slugs, door lintels.
- **Furniture**: a Furnish tool with a nine-piece catalogue compiled to the program's
  `details` ops, rotated blocks-and-footprint together.

**Generation engine:**
- Paid responses are never lost (`onProgram` now persisted on failure), transient provider
  failures retry with backoff on fresh sessions, a repair round that cannot run falls back to
  the first program instead of discarding it, prompt cap 600 → 2000 chars, refine accepts a
  reference picture with the picture brief included, fine-grained tool streaming on the
  plain API path.

**Editor tooling (S1):**
- The `EditorTool` registry (`editor/tools/registry.ts`) — every tool is one object with
  `onClick`/`onStroke`/`preview`, replacing the three parallel switches in EditorPage.
- **Grab** (key 9): click any block to lift the whole connected structure into the clipboard
  and stamp it back down elsewhere; undo puts it back.
- **Symmetry mode**: a palette toggle that mirrors every place/erase/fill/line across the
  build's east–west midplane, stair facings included.

**Generation depth (S2):**
- **Diff refine**: refines now offer the model a second tool, `edit_build_program`, that
  emits a short list of ops (`replaceComponent`, `addComponent`, `removeComponent`,
  `setPalette`, `setParam`, `setMeta`) addressed to component `id`s — an additive IR field
  the pipeline assigns before the refine. Untouched components are preserved *by
  construction*; a sweeping change still falls back to the full emit tool. The refine's
  program block is prompt-cached. Applier: `packages/core/src/ir/patch.ts`.
- **Escalating repair**: when the single repair round still leaves an *empty* build, one
  extra repair attempt runs, budget-gated at a stricter bar; a flawed-but-standing build
  keeps returning with omissions rather than buying another round.
- **Eval harness** (`tools/eval/run.mjs`): golden prompt set + deterministic metrics from
  core (block count, expansion errors, role coverage, enclosed-interior ratio, sheltered
  air). `--offline` scores stored programs for free; `--live` spends real money and shares
  the server's spend ledger. Prompt changes ship with before/after numbers or not at all.
- **Prompt**: a second worked example (the round tower — cylinder/sphere/noise fill) and an
  interiors paragraph (floors per storey, stairs between them, interior lighting). *Not yet
  validated with a live eval run — this box has no API key; run `tools/eval/run.mjs --live`
  before shipping the prompt to production.*

**Architecture round-trip (S3):**
- The compiler tags every component with the plan item that drew it (the additive `id`
  field; room labels ride as `label`). Clicking a wall in the 3D model resolves voxel →
  part → component id → plan item and selects it on the plan, jumping storeys if needed.
- **Plans persist server-side**: migration 006 adds `plan jsonb` to builds; a library save
  from Architecture mode carries the drawing beside program + voxels, the library card grows a
  "Plan" action, and `/layouter?plan=lib:<id>` reopens it — walls still walls.
- An L-shape whose room overlap is exactly wall-deep no longer warns (locked by test).

**Studio shell (S4):**
- `/studio` hosts both tools as modes — Build (the voxel editor) and Plan (Architecture mode,
  `?mode=plan`) — behind one address, with a floating mode pill and per-mode undo intact.
- **Ctrl+K command palette**: switch mode, open any sample or recent generated build,
  restyle with any pack, open the guide, jump to library/dashboard/mod. Every command is a
  navigation, so the palette can never do something a link could not.
- `/editor` and `/layouter` live on as search-preserving redirects (old shared links keep
  working, `?build=…&p.*` intact); AppNav collapses Editor+Layouter into one Studio entry.

**Three tiers (S5):**
- The Layouter is now **Architecture**, and the studio has a third mode: **World**. Build makes
  a structure, Architecture makes what is inside one, and both save as *components* — a saved
  build carries a `kind` (migration 007) so a shelf can offer structures and interiors
  separately instead of offering you every row in your library.
- `packages/core/src/world/` holds the world document and `materializeRegion`. A world is a
  description — a 3-byte-per-column heightfield, a sparse 16³ overlay for caves and overhangs,
  and placements by build id — that materialises into an ordinary `VoxelGrid` one region at a
  time. That is also exactly the shape region-by-region delivery needs, so the two constraints
  agree with each other rather than fighting.
- World mode: a top-down raster map to sculpt in, the editor's own renderer for the 3D check,
  and seven column tools (Raise, Lower, Flatten, Smooth, Terrainer, Carve, Place). Drafts in
  IndexedDB, per-stroke delta undo, `tools/verify-world.mjs` with 21 checks.
- Binary voxel transport (S0) landed first and had to: `POST /api/builds` sent voxels as a JSON
  number array with no `bodyLimit`, so a build at the engine's own 256×160×256 cap was a 20 MB
  body against Fastify's 1 MiB default — 20× too large to save. It is now 0.15 MB.

**Delivery and persistence (S6):**
- **Region-by-region delivery works.** `JobManager` centred every build on the player, so
  without an offset every region of a world would have landed on top of the last. `job.offer`
  now carries optional region metadata, the mod places region *n>0* at `anchor + turned
  offset`, and the server refuses to offer a later region until region 0 has reported where
  it landed. The rotation is the subtle half: a map placed at a quarter turn has to have its
  region offsets turned with it, or it comes out scattered.
- `maxVolume` was announced in `hello.ok` and checked by nobody. It is enforced now.
- **Worlds have their own table** (migration 008) and five routes, with the heightfield in
  `bytea` and a 32 MB body limit. The client picks its store from the auth state, so signed
  out is not a degraded mode — it is the same code against IndexedDB.

## Remaining roadmap (approved, not yet built)

1. **N-variation generation** with a thumbnail picker, and complexity-based effort/model
   routing — both gated on live eval numbers.
2. **The renderer ceiling.** `VoxelWorld` still meshes every chunk at load and keeps every mesh,
   so the honest limit is about 384×160×384 — fine for one region, not for a whole world in one
   view. A camera-driven working set with eviction is the fix.
3. **Truncated edge regions under rotation.** Anchor plus turned offset is exact while every
   region shares a footprint, which holds when the map's extent divides by `regionSize`. An
   edge region is narrower, and under a quarter turn it sits off by the difference. Unrotated
   maps are exact regardless.

Explicitly rejected (with reasons recorded in the plan): a Mojang texture atlas (asset
redistribution), a program→plan decompiler (lossy inverse), a wall-graph rework, smart
edit re-anchoring on resize, and new IR component types ahead of the eval harness.
