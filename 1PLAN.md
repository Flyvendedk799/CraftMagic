# CraftMagic — working plan (MVP → coherent product)

> **This file is working memory for the coding agent that executes it.**
> Keep it updated as you go: check off done work, add notes under each phase, and
> revise later phases when something you learn changes them. Do not treat it as a
> frozen deliverable. Prefer amending this file over inventing a parallel plan.

**Status:** P0–P5 complete on branch `claude/complete-1plan-md-gmef5a` (see **Progress log**
and the per-phase **Notes** for what could and could not be verified in this environment).
**Last updated:** 2026-09-06

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

**Where this stands (2026-09-06):** every numbered item is wired end to end in code and covered
by unit tests where a pure function carries the rule (handoff URLs, mode parameters, onboarding
conditions, the edge-region offset, the hub's ordering and restart recovery). What could not
be exercised in this environment: the database-backed server suites (no Postgres; they
`describe.skip` themselves and say so), the in-game loop (`tools/verify-agent.mjs`,
`verify-world.mjs` need a running database and, for the latter, Edge on Windows), and a real
multi-region send. The migration and SQL were written against the existing schema and the
store's own conventions; run `npm test --workspace @craftmagic/server` with `DATABASE_URL` set
before deploying, and `tools/verify-agent.mjs` against staging.

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

- [x] Fix `AccountPanel` copy: anonymous users get samples, edit, schem, guide — **not**
      generation, library, pairing, or send-to-game. Align with README M5 policy.
- [x] Rename dashboard “Worlds” / onboarding step language to **paired Minecraft** (or
      “Minecraft servers”). Reserve “World” / “Maps” for World mode (`/studio?mode=world`).
- [x] Audit empty states: Library `FirstBuild`, Architecture shelves, World Place shelf — each
      must point at a real next action (sign in, save a build, open Architecture, open World).
- [x] Fix ExportBar / Architecture: if `guideHref` is null, either compute one (register/
      save + link) or label the missing action — do not show a complete Export section that
      cannot open a guide.
- [x] World ExportBar copy: state clearly that download/send applies to the **current region**,
      not the whole map (unless/until whole-map send is real).
- [x] Grep for other stale claims (“works without an account,” “M4 will…,” hologram). Fix UI
      strings now; README cleanup can wait until after P2 unless it confuses you mid-run.

### Verify

- Signed-out: try Generate and Send — UI explains account requirement before the API 401.
- Dashboard: no card titled in a way that could mean World-mode maps.
- Architecture Export: guide is reachable in one obvious click for a compiled plan.
- World Export: region framing is readable without reading source comments.

### Notes

- `AccountPanel` now carries `ACCOUNT_LINE`, the one honest sentence about what needs an
  account, shown wherever a caller supplies no invitation (the studio HUDs). The PromptPanel,
  SendToGame and SaveToLibrary each already said their own half before the 401; the panel's
  header had been the one place still claiming the opposite.
- "Worlds" → "Paired Minecraft" on the dashboard card, the stat band, the pairing button, the
  onboarding step (`pairedAgents`), SendToGame, the mod page and the palette hint. Prose that
  says "your Minecraft world" for the game instance was kept — it is the game's own word — and
  disambiguated with "Minecraft" wherever a bare "world" could be read as a map.
- `ExportBar` grew `onGuide` (a verb for pages whose document has no id until asked),
  `scopeNote` (World's "region on screen, not the map"), `sendTitle`, `afterSave`,
  `libraryRowId`, `onSaved`, `generationId`. Architecture's guide moved into the Export section
  through `onGuide`; World's guide registers the materialised region as a voxel build in the
  import store with `source: 'region'` (so the build menu calls it a map region, not a
  schematic) and opens the guide on that id.
- Empty states now link: the library's `FirstBuild` has four doors (describe, draw a
  floorplan, sample, empty plot); Architecture's shelf links to Build and the dashboard; the
  World shelf explains that terrain works signed out, placing needs an account, and links to
  sign-in, Build and Architecture.
- The editor HUD's "Deployment checks →" link to `/status` was the last product surface
  pointing at a milestone page; removed in P5 with the page retitled.

---

## Phase 1 — One journey (narrative + onboarding)

**Goal:** Every entry surface teaches the same end-to-end path, including Architecture and World
as optional but real steps — not mystery pills.

### Tasks

- [x] **Landing:** Update the how-it-works / editor story so Architecture (draw a floorplan)
      and World (place builds on terrain) appear as part of the product, without turning the
      hero into a feature dump. Keep one primary CTA (sign up / dashboard). Secondary link to
      try a sample in studio is fine.
- [x] **Dashboard:**
  - Keep the prompt launcher as the primary “start.”
  - Add clear doors: Open Studio (Build), Draw a floorplan (Architecture), Compose a map
    (World).
  - Show **Maps** (signed-in `/api/worlds` list, open in World mode) separately from
    **Paired Minecraft**.
  - Keep recent library builds; ensure cards expose Open / Guide / Plan (if `hasPlan`) /
    Place on map.
- [x] **Onboarding** (`onboarding.ts` + tests): extend without lying.
  Shape shipped: 1. Create account → 2. Save a build → (optional) Place it on a map →
  3. Pair Minecraft → 4. **Send a build** (finale, ticks only on a job that reached `done`).
- [x] **Job observability for onboarding:** `GET /api/agent/jobs/summary` →
      `{ successful, lastSuccessAt }` from `agent_jobs WHERE status = 'done'`, fetched by
      `useDashboard` alongside builds, maps and spend.
- [x] **AppNav / studio mode pill:** `MODE_SPECS` hints now say what each mode makes; the
      Studio nav entry carries the same as a hover hint; World is reachable from the dashboard
      doors, the Maps card, every build card and the palette.

### Verify

- New account click-path: landing → signup → checklist → save → pair → send → checklist done.
- Someone who never opens the mode pill can still discover Architecture and World from
  dashboard.
- `onboarding.test.ts` covers new steps and does not tick “sent” on pair-only.

### Notes

- The optional map step is observable from the `placements` count the worlds listing already
  carries, so it cost no schema. It is shown, drawn quieter, and never counted: `onboardingProgress`
  totals required steps only, so the checklist can finish without it.
- The landing's three steps became Make → Shape & save → Build, naming Architecture in step 1
  and World in step 2 without adding a section; the hero lede mentions "draw its floorplan"
  and "place it on a map".
- The dashboard rewrite kept every rule in its header. The right column is now a stack of
  Paired Minecraft and Maps; all build links go through `studio/handoff.ts`.
- `/api/agent/jobs/summary` is declared before `/api/agent/jobs/:id`; the router matches the
  static segment first either way. Not exercised against Postgres here (see Definition of done).

---

## Phase 2 — Handoffs that compose (structural fix)

**Goal:** Modes stop being peer demos. Crossing them preserves work and intent.

### Tasks

- [x] **Stable handoff helpers** (web): `apps/web/src/studio/handoff.ts` — `openInBuild`,
      `openPlan`, `drawFloorplan`, `placeOnMap`, `openMap`, `composeMap`, `openGuide`,
      `libRef`/`libRowId`/`isDurable`; pinned by `handoff.test.ts`. Dashboard, library,
      editor, Architecture, World and the palette all build their links through it.
- [x] **Architecture → Build:** refine and "Open in Build" navigate through the helper; copy
      says the result is a copy in Build, the drawing stays here, and the Architecture pill
      brings you back (the autosave restores it). Refine never writes back into the plan.
- [x] **Build → World:** "Place on map" from the library card, the dashboard card, the editor's
      Save section (for a `lib:` build) and the post-save note (for anything just saved) →
      `/studio?mode=world&place=<row>`; `WorldPage` arms the shelf entry in the Place tool,
      loads its blocks, says so in the notice and drops the parameter.
- [x] **Architecture → World:** same path after "Save to library" as `interior`; the World
      shelf shows both kinds by default.
- [x] **World → Build:** the placement inspector links "Edit the source build in Build" with
      the durable id, or says the row is gone when the library could not answer for it.
- [x] **Mode switch behavior:** `MODE_PARAMS` / `foreignParams` in `mode.ts` (tested) name
      which query parameters each mode reads; the shell shows a one-line notice when a
      parameter belongs to another mode ("The build in the address bar belongs to Build mode
      and is not open here"), with Switch / Clear / dismiss. A naked pill switch still keeps
      the query, which is what lets Build get its `?build=` back.
- [x] **Library as component shelf:** empty-shelf CTAs create the missing artifact in the
      right mode (P0); signed-out World sculpting remains allowed and the Place shelf explains
      sign-in + save.

### Verify

- Architecture refine → Build → Save → Library “Plan” reopens the drawing; program is the
  refined one (document the chosen semantics in Notes).
- Build “Place on map” → World Place tool armed with that build → click map → materialised
  region contains it (`verify-world`-style or extend it).
- Mode pill alone does not pretend a transfer happened.

### Notes

- **Chosen semantics for refine:** a refine is a fork. The refined program becomes a new
  generated build in Build; the plan document is untouched; saving from Build stores program +
  voxels + edits (no plan), saving from Architecture stores plan + compiled program. There is
  no row that carries both a refined program and the plan it started from — that would be
  either a lossy decompile (rejected) or the Project entity (deferred). The UI says exactly
  this next to both buttons.
- `?place=` is consumed once the shelf has answered (ready / signed out / error) so a reload
  keeps whatever was placed since. `?world=` waits for the draft read and for auth to settle,
  because `useWorldSession` assigns the stored draft over the live document when it lands.
- The World-side arming was smoke-tested headlessly signed out (the notice path); the
  signed-in arming and the `verify-world`-style materialisation check need a database.

---

## Phase 3 — Persistence matches the mental model

**Goal:** “Saved” means the same thing everywhere once you have an account.

### Tasks

- [x] **Architecture drafts:** the section is titled "Drafts (this browser only)", its button
      "Save draft", and the hint points at Save to library as the durable path.
- [x] **Migrate pressure:** signed in, every draft in the list gets "→ Library" (compile,
      expand, save with the drawing as `interior`) and there is a "Save all N drafts" button.
      Never silent: each is a click, and the result is reported.
- [x] **Worlds on dashboard:** the Maps card lists `/api/worlds`; a map opens by id through
      `?world=`. Draft-only IDB worlds stay local; signed in, the store switches as before.
- [x] **`gen:` lifecycle:** the "Generated for $x" line now says the build lives in this
      browser only until saved. Send-to-game's transport row stays out of the library by the
      existing `in_library` policy — written down in `useAgents`' header as intentional.
- [x] **`generations.build_id`:** the done event carries the audit row's id, the editor keeps
      it with the generated build, Save posts it as `generationId`, and the server links the
      two rows (`AgentStore.linkGeneration`, ownership in the predicate, best effort).
- [x] **Edits on send path:** `sendToGame` posts `detached` and the edit layer beside the
      program, exactly as Save does; the ExportBar passes `getEdits` through.

### Verify

- Signed-in Architecture save → other browser/session can reopen via library Plan.
- Dashboard lists maps; opening one restores placements.
- Send does not surprise-create clutter without UX explanation.

### Notes

- A "save over" for library builds does not exist (the PATCH only renames) and was not added:
  the Save section says "Saves a new copy" when the build was opened from the library, which is
  the honest version of the current behaviour. A proper update route is a reasonable follow-up.
- Draft upload compiles against the currently loaded catalogue; a draft that places saved
  builds whose blocks have not been fetched compiles with warnings, which the note reports.

---

## Phase 4 — Delivery dead ends (server / mod loop)

**Goal:** Send-to-game and world send survive contact with reality.

### Tasks

- [x] **Durable world-run anchors:** migration `009_job_regions.sql` adds `agent_jobs.region`
      (jsonb, indexed by world); `createJob` stores the region (anchor stripped); every job
      read returns it; `AgentStore.worldAnchor(worldId)` joins the latest region 0 to its build
      for the anchor and footprint. The hub's maps are a cache in front of the rows: `attach`
      replays pending regions from the row, `noteJobState` takes the row's region as a hint
      after a restart, and a fresh region 0 clears an earlier run's anchor.
- [x] **Truncated edge regions under rotation:** `packages/core/src/world/delivery.ts` —
      `deliveryOffset(offset, rotation, first, region)` pre-corrects the offset the mod adds
      by `unturn(shift(regionN) − shift(region0))`, where `shift` is the low corner of the
      turned box `BuildTask.plan()` builds from. Locked by a simulation of the mod's
      placement arithmetic over a 300×300 map at every quarter turn; full regions and
      unrotated maps get the offset back byte for byte. **No mod change** — the mod's one sum
      is unchanged and older mods are unaffected.
- [x] **One-job UX:** a 409 `agent_busy` now says Minecraft is still building an earlier send
      and offers "Stop that build" (the cancel route has existed since jobs did); a refused
      offer shows the server's own sentence.
- [x] **Pairing / mod page:** `/mod` says pairing needs an account and links sign-up; the jar
      and manifest are committed under `apps/web/public/mod/` (checked); README's bundle path
      corrected.
- [x] **Smoke:** hub tests extended (20, including restart recovery, second-run isolation and
      the edge-region correction); `region.test.ts` unchanged and green. `verify-agent.mjs`
      and the in-game loop need a database and were not run here.

### Verify

- Multi-region world send with a quarter-turn placement: edge regions land correctly.
- Kill server mid-run after region 0 anchored: after restart, either resume cleanly or fail
  with a clear “restart the send” message — never silent incomplete scatter.
- Lone build wand place still works.

### Notes

- The correction is server-side on purpose: the fix had to work for the mod jar already in
  players' `mods/` folders, and the mod's arithmetic is right for what it is handed. A mod
  rebuild was not needed and none was made.
- Restart behaviour after this change: region 0 anchored, server restarted, region 1 sent →
  the hub finds region 0's anchor and footprint in the rows and delivers. If region 0 had not
  yet reported, the refusal is the same honest sentence as before. The client's send-all loop
  already stops on the first failure.

---

## Phase 5 — Polish (only after P0–P4)

**Goal:** One-tool feel without new product surfaces.

### Tasks

- [x] Command palette: "Open the map draft", "Open map: <name>" for the account's (or this
      browser's) maps, and for the five most recent library builds "Open build", "Place on
      map" and "Open the build guide" — every one a navigation through `handoff.ts`.
- [x] Library empty state: doors for prompt, Architecture, sample and empty plot (P0).
- [x] Status page: retitled "Deployment checks", tagline says it is ops, back-link goes to the
      studio; the editor's link to it removed.
- [x] README: intro states the product path and points at `1PLAN.md` / `docs/PATCH-2.0.md`;
      M4 marked done; generated builds described as localStorage; M6 paragraph restamped
      (doors, Maps, Paired Minecraft, checklist finale, AppNav on every screen); new M7
      paragraph; bundle-mod path corrected; `.claude/plans/` pointer replaced.
- [ ] Optional from PATCH remaining: N-variation generation, flat-grid / per-region feed —
      deliberately not done (eval-gated; see Non-goals).

### Verify

- Ctrl+K can reach World maps and Place without reading source.
- Landing + README + UI no longer contradict each other on accounts or modes.

### Notes

- Headless smoke (Chromium via Playwright, signed out, no database): landing, dashboard,
  library, mod page, `/studio` in all three modes, the foreign-parameter notice in World and
  Build, `?place=` signed out, the palette's map draft command, and the status page — see the
  Progress log for the run.

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
| Routes / shell | `apps/web/src/App.tsx`, `studio/StudioPage.tsx`, `studio/mode.ts`, `studio/handoff.ts` |
| Narrative | `landing/LandingPage.tsx`, `dashboard/DashboardPage.tsx`, `dashboard/onboarding.ts`, `dashboard/useDashboard.ts` |
| Build | `editor/EditorPage.tsx`, `editor/ExportBar.tsx`, `editor/builds.ts`, `generate/*` |
| Architecture | `architecture/ArchitecturePage.tsx`, `architecture/storage.ts`, `architecture/compile.ts` |
| World | `world/WorldPage.tsx`, `world/storage.ts`, `world/send.ts`, `packages/core/src/world/*` (incl. `delivery.ts`) |
| Library / auth | `library/*`, `agent/useAgents.ts`, `agent/SendToGame.tsx` |
| Server | `apps/server/src/agent/{hub,routes,store}.ts`, `generate/*`, `db/migrations/*` (009 is the job region) |
| Mod | `mod/src/main/java/dev/craftmagic/agent/**` (unchanged by this plan) |
| Prior patch notes | `docs/PATCH-2.0.md` (remaining items + rejects) |

---

## Judgment calls baked into this plan

These are intentional. Overturn them in **Notes** if evidence says so, and revise phases.

1. **No new Project entity yet.** Coherence comes from journey + handoffs + honest persistence,
   not another table. Revisit only if P2–P3 still feel bolted together. *(Held. After P2–P3
   the seams are explicit verbs with durable ids; nothing needed a wrapper table.)*
2. **Architecture refine stays a fork into Build for voxels/program**, with the plan preserved
   as the drawing. Bidirectional plan sync is rejected (lossy). Clarity over magic. *(Held;
   semantics documented in P2 Notes and in the UI copy.)*
3. **World remains region-exported**, not a single mega-schem. Product honesty > fake
   whole-map download. *(Held; the scope note now says so on the bar.)*
4. **Onboarding finale is “successful job,”** not “agent online.” Requires a small API/schema
   addition — worth it so the checklist has a real finish line. *(Done with an endpoint and no
   schema change: `status = 'done'` was already the fact.)*
5. **P0 naming fix (Worlds vs Maps)** is mandatory even though it is “just copy” — it is the
   highest-frequency conceptual bug in the UI. *(Done.)*
6. **Generation quality / N-variants / mesher LOD** are explicitly after E2E coherence. A
   prettier demo that still dead-ends is the failure mode this plan exists to prevent. *(Not
   touched.)*
7. **Edge-region rotation fix lives on the server** (new in execution): the mod's sum is
   correct for what it is handed, players already run the jar, and a pure function with a
   simulation test is a stronger guarantee than a Java change nobody here can run in-game.

---

## Progress log

| Date | What changed |
|---|---|
| 2026-09-06 | Plan authored after full repo read. No code changes. |
| 2026-09-06 | P0–P5 executed on `claude/complete-1plan-md-gmef5a`. Verified here: `npm run typecheck` clean; core 471 tests, web 370 tests, server 127 tests (+61 database-backed tests skipped for lack of Postgres) green; `vite build` clean; headless Chromium smoke of every door signed out. Not verified here: database-backed suites, `verify-agent.mjs`, `verify-world.mjs`, in-game send. |
