# CraftMagic — working plan (MVP → coherent product)

> **This file is working memory for the coding agent that executes it.**
> Keep it updated as you go: check off done work, add notes under each phase, and
> revise later phases when something you learn changes them. Do not treat it as a
> frozen deliverable. Prefer amending this file over inventing a parallel plan.

**Status:** not started  
**Last updated:** 2026-09-06 (plan authored from full-repo read; no implementation yet)

---

## How to use this plan

1. Read **Diagnosis** and **Definition of done** before writing code.
2. Execute phases in order. P0–P2 are the product fix; P3–P4 make it durable; P5 is polish.
3. After each phase: mark checkboxes, write a short **Notes** section with what you learned,
   and adjust later phases if the diagnosis shifted.
4. Prefer the smallest change that closes a real dead end over new surfaces.
5. Do not revive rejected ideas (see **Non-goals**). Do not expand scope into “more makers.”

---

## Diagnosis (root cause)

### Symptom (given)

Features exist as disconnected demos. A real user cannot open the product and walk end to end
without hitting dead ends, confusion, or silent loss of work.

### Cause (found in code — do not skip)

CraftMagic grew by stacking **peer makers** that share export machinery but **not a shared
document, journey, or persistence story**:

| Maker | Document | Persistence | Compiles to |
|---|---|---|---|
| **Build** | `BuildProgram` + edit layer + voxels | URL / `gen:` localStorage / library Postgres | Itself |
| **Architecture** | Floorplan (`plan`) | **localStorage drafts** + optional library `plan` jsonb | `BuildProgram` via `compile.ts` |
| **World** | Heightfield + overlays + placements | **IndexedDB** or `/api/worlds` | Regions → ordinary grids/jobs |

They are mounted as peers behind `/studio?mode=` (`StudioPage` unmounts inactive modes; separate
histories; World state is not in the URL). The connective tissue that *does* exist —
`ExportBar`, library-as-prefab-shelf, agent WebSocket — is real. What is missing is:

1. **Composition in the UI.** Switching modes does not “take this into that.” Architecture AI
   refine forks into Build and leaves the plan untouched. World Place requires a signed-in
   library that nothing on the landing page teaches you to fill.
2. **A journey that matches the studio.** Landing, dashboard, and onboarding still narrate the
   **v1** loop only: describe → voxel editor → schem / guide / bot. Architecture is a chip;
   World mode is invisible. Dashboard “Worlds” means **paired Minecraft agents**, not World-mode
   maps — a naming collision that guarantees confusion.
3. **Persistence stratified by accident.** Users experience “save” differently in each mode
   (browser plan vs library build vs IDB/API world). `gen:` builds die with the browser unless
   saved. AccountPanel still claims anonymous generate/send works — that is **false** (M5).

So the gimmick feeling is not “too few features.” It is **three finished tools and a dashboard
that still sells one of them**, with handoffs that look like exports instead of a workflow.

The engine underneath (IR → expand → edit layer → schem / guide / agent → wand/bot) is solid.
Do not rebuild the core. Rebuild the **path through it**.

---

## Definition of done

A new user can, without prior knowledge of the repo:

1. Sign up from the landing page.
2. Make a structure (prompt **or** Architecture floorplan **or** sample).
3. Save it to the library and reopen it later (same device and, when signed in, another).
4. Optionally place that structure on a World map (terrain + placement).
5. Install/pair the mod and send either a single build or a world region into Minecraft.
6. Download `.schem` and open a printable guide for the same artifact.
7. Never hit a UI that promises a next step that does not exist, or a “save” that only lives in
   an unlabeled browser draft while looking like account storage.

When that path is boring and reliable, stop. Further generation quality / renderer scale work
is optional (see P5 / Later), not part of “product.”

---

## Non-goals (do not do these)

Carried from `docs/PATCH-2.0.md` and this read — still rejected unless the human overturns them:

- Mojang texture atlas (asset redistribution).
- Program → plan decompiler (lossy inverse).
- Wall-graph rework of Architecture.
- Smart edit re-anchoring on resize (edit layer already composites).
- New IR component types ahead of eval evidence.
- A heavyweight “Project” table that wraps builds+plans+worlds **before** handoffs and
  narrative are fixed. Library builds + worlds + explicit verbs are enough for v1 product.
- N-variation generation / effort routing (needs live eval; not a dead-end fix).
- Rewriting `VoxelWorld` to a per-region feed (scale ceiling; not required for E2E product).

---

## Product principles (for every change)

1. **One story on every door.** Landing, dashboard, onboarding, and studio pills must name the
   same progression: Make → Save → (optional) Compose on a map → Build in Minecraft / Export.
2. **Handoffs carry identity.** “Open in Build,” “Place on map,” “Send to game” must pass a
   stable id (`lib:…` preferred; register `gen:` only as a bridge and push Save).
3. **Save means account when signed in.** Browser drafts are fine if labeled “Draft (this
   browser only).” Never imply sync for localStorage-only plans.
4. **Name collisions are bugs.** “World” = World-mode map. Paired game instances = “Minecraft”
   or “Paired servers,” never “Worlds” on the dashboard.
5. **Dashboard stays a view.** No second implementations of library/agents/worlds APIs.
6. **Observable checklist steps.** Onboarding ticks only from data the page already has (or
   adds a real endpoint). Do not infer “sent a build” from “agent was online.”

---

## Phase 0 — Truth and naming (do first)

**Goal:** Stop lying and stop colliding names. Cheap trust repair.

### Tasks

- [ ] Fix `AccountPanel` copy: anonymous users get samples, edit, schem, guide — **not**
      generation, library, pairing, or send-to-game. Align with README M5 policy.
- [ ] Rename dashboard “Worlds” / onboarding step language to **paired Minecraft** (or
      “Minecraft servers”). Reserve “World” / “Maps” for World mode (`/studio?mode=world`).
- [ ] Audit empty states: Library `FirstBuild`, Architecture shelves, World Place shelf — each
      must point at a real next action (sign in, save a build, open Architecture, open World).
- [ ] Fix ExportBar / Architecture: if `guideHref` is null, either compute one (register/
      save + link) or label the missing action — do not show a complete Export section that
      cannot open a guide.
- [ ] World ExportBar copy: state clearly that download/send applies to the **current region**,
      not the whole map (unless/until whole-map send is real).
- [ ] Grep for other stale claims (“works without an account,” “M4 will…,” hologram). Fix UI
      strings now; README cleanup can wait until after P2 unless it confuses you mid-run.

### Verify

- Signed-out: try Generate and Send — UI explains account requirement before the API 401.
- Dashboard: no card titled in a way that could mean World-mode maps.
- Architecture Export: guide is reachable in one obvious click for a compiled plan.
- World Export: region framing is readable without reading source comments.

### Notes

_(agent: fill in)_

---

## Phase 1 — One journey (narrative + onboarding)

**Goal:** Every entry surface teaches the same end-to-end path, including Architecture and World
as optional but real steps — not mystery pills.

### Tasks

- [ ] **Landing:** Update the how-it-works / editor story so Architecture (draw a floorplan)
      and World (place builds on terrain) appear as part of the product, without turning the
      hero into a feature dump. Keep one primary CTA (sign up / dashboard). Secondary link to
      try a sample in studio is fine.
- [ ] **Dashboard:**
  - Keep the prompt launcher as the primary “start.”
  - Add clear doors: Open Studio (Build), Draw a floorplan (Architecture), Compose a map
    (World).
  - Show **Maps** (signed-in `/api/worlds` list, open in World mode) separately from
    **Paired Minecraft**.
  - Keep recent library builds; ensure cards expose Open / Guide / Plan (if `hasPlan`) /
    Place on map.
- [ ] **Onboarding** (`onboarding.ts` + tests): extend without lying.
  Suggested shape (adjust if data is missing — then add the endpoint first):
  1. Create account  
  2. Save a build to the library (prompt or Architecture — both OK)  
  3. Pair Minecraft  
  4. **Send a build** (finale) — requires observable job success (see below)
  - Optional intermediate: “Place a build on a map” if worlds list can prove a placement
    exists; skip if not observable without schema work (push to P3).
- [ ] **Job observability for onboarding:** add a minimal, honest signal — e.g. count of
      `agent_jobs` with terminal success for this user, or `users.first_successful_job_at`.
      Dashboard already loads agents; extend API/`useDashboard` rather than scraping SSE.
- [ ] **AppNav / studio mode pill:** short hints that match `MODE_SPECS`; ensure World is
      discoverable from dashboard, not only from the pill.

### Verify

- New account click-path: landing → signup → checklist → save → pair → send → checklist done.
- Someone who never opens the mode pill can still discover Architecture and World from
  dashboard.
- `onboarding.test.ts` covers new steps and does not tick “sent” on pair-only.

### Notes

_(agent: fill in)_

---

## Phase 2 — Handoffs that compose (structural fix)

**Goal:** Modes stop being peer demos. Crossing them preserves work and intent.

### Tasks

- [ ] **Stable handoff helpers** (web): one module or shared functions for
      `openInBuild(libId | genId)`, `openPlan(libId | localPlanId)`, `placeOnWorld(libId)`,
      `openGuide(buildRef)`. Prefer `lib:` ids. When only a program exists, save or
      `registerGeneratedBuild` then immediately prompt Save to library if signed in.
- [ ] **Architecture → Build:** “Open in editor” / refine result must not feel like abandoning
      the plan.
  - Preferred: keep the library row’s `plan` + program linked; refine updates the **program**
    (and voxels/edits) while the plan document remains the floorplan source; UI says
    “Refinement opens in Build; your plan drawing stays here.”
  - Do **not** silently mutate the plan from voxel refine (lossy). Do not pretend refine
    rewrote rooms if it did not.
- [ ] **Build → World:** from ExportBar or build menu: “Place on map” → `/studio?mode=world`
      with the build armed in the Place tool (query or session flag). If no map exists, create
      or open draft and arm Place.
- [ ] **Architecture → World:** same, after compile/save as `kind: interior` or structure as
      appropriate.
- [ ] **World → Build:** selecting a placement can “Edit source build” → library open in Build
      (read-only note if missing).
- [ ] **Mode switch behavior:** switching pills may still unmount (OK for now), but when a
      handoff verb was used, restore the armed context. Naked pill switch should not claim to
      transfer the open `?build=` into World (today’s silent no-op). Strip or ignore irrelevant
      query params per mode, or show a one-line “Build query ignored in World.”
- [ ] **Library as component shelf:** empty shelf CTAs create the missing artifact in the
      right mode. Signed-out World sculpting remains allowed; Place shelf explains sign-in +
      save.

### Verify

- Architecture refine → Build → Save → Library “Plan” reopens the drawing; program is the
  refined one (document the chosen semantics in Notes).
- Build “Place on map” → World Place tool armed with that build → click map → materialised
  region contains it (`verify-world`-style or extend it).
- Mode pill alone does not pretend a transfer happened.

### Notes

_(agent: fill in)_

---

## Phase 3 — Persistence matches the mental model

**Goal:** “Saved” means the same thing everywhere once you have an account.

### Tasks

- [ ] **Architecture drafts:** label local autosave / named local plans as browser drafts.
      Primary CTA when signed in: Save to library (already stores `plan`). Opening
      `?plan=lib:…` remains the durable path.
- [ ] **Migrate pressure:** if a signed-in user has local-only named plans, offer “Save to
      library” batch or per-plan — not a silent upload.
- [ ] **Worlds on dashboard:** list API worlds; open by id in World mode. Draft-only IDB worlds
      when signed out stay local; on sign-in, keep current behavior (client picks store from
      auth) but surface named worlds on the dashboard.
- [ ] **`gen:` lifecycle:** after generation, soft prompt to save; before Send to game, prefer
      library row (Send already POSTs a build — ensure `in_library` policy is intentional:
      transport rows vs library rows from migration 002). Avoid flooding the library with
      send artifacts the user did not ask to keep — or mark them clearly.
- [ ] **`generations.build_id`:** when user saves a generated build, link the generation row if
      present (column exists, unused). Nice for support/quota UX; not blocking if costly.
- [ ] **Edits on send path:** `sendToGame` currently posts composited grid + program but not
      always `edits`. Either attach edit layer like `SaveToLibrary`, or document that transport
      voxels are authoritative and skip stale program on reopen from that row.

### Verify

- Signed-in Architecture save → other browser/session can reopen via library Plan.
- Dashboard lists maps; opening one restores placements.
- Send does not surprise-create clutter without UX explanation.

### Notes

_(agent: fill in)_

---

## Phase 4 — Delivery dead ends (server / mod loop)

**Goal:** Send-to-game and world send survive contact with reality.

### Tasks

- [ ] **Durable world-run anchors:** `hub.ts` keeps `worldAnchors` / region job state in memory.
      Persist enough that a server restart mid multi-region send does not strand regions
      (DB table or columns on `agent_jobs` / a `world_runs` table). Mod already places
      continuations from anchor + turned offset.
- [ ] **Truncated edge regions under rotation** (`docs/PATCH-2.0.md` remaining #3): fix offset
      math for non-full edge tiles under quarter turns. Unrotated maps already exact.
- [ ] **One-job UX:** when agent busy (409), UI says what is building and how to wait/cancel if
      cancel exists; if not, do not invent cancel without server support.
- [ ] **Pairing / mod page:** checklist and `/mod` stay the only install path; verify jar is
      bundled in deploy (`tools/bundle-mod.mjs`). Confirm AccountPanel/mod copy agree on
      account requirement.
- [ ] **Smoke:** `tools/verify-agent.mjs`, world region send path, and a clean Fabric install
      check remain the bar — not `runClient` alone (README’s lesson).

### Verify

- Multi-region world send with a quarter-turn placement: edge regions land correctly.
- Kill server mid-run after region 0 anchored: after restart, either resume cleanly or fail
  with a clear “restart the send” message — never silent incomplete scatter.
- Lone build wand place still works.

### Notes

_(agent: fill in)_

---

## Phase 5 — Polish (only after P0–P4)

**Goal:** One-tool feel without new product surfaces.

### Tasks

- [ ] Command palette: World commands (open draft, open named map, arm Place for recent lib
      build) — still navigation/flags only.
- [ ] Library empty state: doors for prompt, Architecture, and sample — not Build-only.
- [ ] Status page: keep as ops smoke; do not link from product nav as a milestone museum.
- [ ] README: restamp milestones (M4 delivery is done; `.claude/plans/` is gone — point at
      `1PLAN.md` / `docs/PATCH-2.0.md`). Do this once narrative matches reality.
- [ ] Optional from PATCH remaining: N-variation generation, flat-grid / per-region feed —
      only if E2E path is already boring and eval/budget allow.

### Verify

- Ctrl+K can reach World maps and Place without reading source.
- Landing + README + UI no longer contradict each other on accounts or modes.

### Notes

_(agent: fill in)_

---

## Suggested implementation order (when in doubt)

```
P0 (copy/naming/export honesty)
 → P1 (landing/dashboard/onboarding + job signal)
 → P2 (handoff verbs + armed Place + refine semantics)
 → P3 (draft labeling + maps on dashboard + send/library hygiene)
 → P4 (durable anchors + rotation edge bug)
 → P5 (palette/README polish)
```

If blocked on P4 (mod/Java), continue P1–P3 on web/server; do not stall the product path on
hologram or renderer rewrites.

---

## Key files (start here)

| Area | Paths |
|---|---|
| Routes / shell | `apps/web/src/App.tsx`, `studio/StudioPage.tsx`, `studio/mode.ts` |
| Narrative | `landing/LandingPage.tsx`, `dashboard/DashboardPage.tsx`, `dashboard/onboarding.ts` |
| Build | `editor/EditorPage.tsx`, `editor/ExportBar.tsx`, `editor/builds.ts`, `generate/*` |
| Architecture | `architecture/ArchitecturePage.tsx`, `architecture/storage.ts`, `architecture/compile.ts` |
| World | `world/WorldPage.tsx`, `world/storage.ts`, `world/send.ts`, `packages/core/src/world/*` |
| Library / auth | `library/*`, `agent/useAgents.ts`, `agent/SendToGame.tsx` |
| Server | `apps/server/src/agent/{hub,routes,store}.ts`, `generate/*`, `db/migrations/*` |
| Mod | `mod/src/main/java/dev/craftmagic/agent/**` |
| Prior patch notes | `docs/PATCH-2.0.md` (remaining items + rejects) |

---

## Judgment calls baked into this plan

These are intentional. Overturn them in **Notes** if evidence says so, and revise phases.

1. **No new Project entity yet.** Coherence comes from journey + handoffs + honest persistence,
   not another table. Revisit only if P2–P3 still feel bolted together.
2. **Architecture refine stays a fork into Build for voxels/program**, with the plan preserved
   as the drawing. Bidirectional plan sync is rejected (lossy). Clarity over magic.
3. **World remains region-exported**, not a single mega-schem. Product honesty > fake
   whole-map download.
4. **Onboarding finale is “successful job,”** not “agent online.” Requires a small API/schema
   addition — worth it so the checklist has a real finish line.
5. **P0 naming fix (Worlds vs Maps)** is mandatory even though it is “just copy” — it is the
   highest-frequency conceptual bug in the UI.
6. **Generation quality / N-variants / mesher LOD** are explicitly after E2E coherence. A
   prettier demo that still dead-ends is the failure mode this plan exists to prevent.

---

## Progress log

| Date | What changed |
|---|---|
| 2026-09-06 | Plan authored after full repo read. No code changes. |
