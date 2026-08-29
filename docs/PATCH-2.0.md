# Patch 2.0 — the editor, layouter and generation engine, taken up a level

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

**Layouter control:**
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

## Remaining roadmap (approved, not yet built)

In priority order; see the architecture notes in the original plan for detail:

1. **Tool registry refactor** (`EditorTool` interface collapsing EditorPage's three parallel
   switches) — the prerequisite for cheap new tools (select-by-block, sphere select,
   symmetry mode, numeric entry, multi-slot clipboard/prefab library).
2. **Studio shell**: `/studio` with command palette + docked panels hosting the editor, the
   layouter as a second mode over a shared `{program, edits?, plan?}` document;
   `/editor` + `/layouter` become search-preserving redirects.
3. **Generation depth**: eval harness first (`tools/eval/` — golden prompts, expansion
   metrics; no prompt change ships without it), then few-shot from `core/src/samples`,
   interiors vocabulary, an escalating second repair round, **diff refine** (a second
   `edit_build_program` tool emitting ops keyed by an additive component `id`, with the
   program block prompt-cached), and N-variation generation with a picker.
4. **Layouter round-trip**: item↔component provenance via the additive `id` field,
   server-side plan persistence (`plan jsonb`), L-shaped rooms via rect union.

Explicitly rejected (with reasons recorded in the plan): a Mojang texture atlas (asset
redistribution), a program→plan decompiler (lossy inverse), a wall-graph rework, smart
edit re-anchoring on resize, and new IR component types ahead of the eval harness.
