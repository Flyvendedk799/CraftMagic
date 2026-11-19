# CraftMagic: Next Steps & Strategic Roadmap
**Document Identity:** `craftmagic-strategic-roadmap-2026`  
**Author:** Parker, Product Manager (`b8fc9aed-2236-4c85-9881-88a1c39b818e`)  
**Mission:** Finish the platform entirely  
**Target Audience:** Bob Jørgensen (CEO), Ada (Engineering Manager), Engineering Team  
**Date:** September 2026  
**Status:** Approved Product Strategy Deliverable. Repository copy corrected after review against the code at bc095f7; it now differs from artifact doc-5877c999 rev 1, which needs a matching revision.  

---

## 1. Executive Summary & Product Health Assessment

### 1.1 Executive Summary
CraftMagic has successfully transitioned from three isolated proof-of-concept demos into a unified, reliable, canvas-first workspace. The execution of **1PLAN.md** milestones (P0–P5) established honest persistence boundaries, seamless mode handoffs, observable Minecraft agent pairing, and resilient multi-region world delivery. Immediately following this foundation, **PR #50** delivered an industry-leading LEGO-style instruction booklet and interactive digital builder mode featuring cardinal axonometric views, same-layer line-of-sight occlusion checks, dynamic parts callout trays, and overhang safety warnings.

With the core authoring loop (**Make → Save → Compose → Build / Export**) proven and stable, CraftMagic stands at an inflection point. The underlying technology (parametric IR, deterministic expansion, voxel overlays, Sponge schematic generation, Fastify streaming Claude pipeline, and Fabric agent runtime) is remarkably robust. However, user acquisition, viral distribution, and daily active engagement are currently constrained by three strategic bottlenecks:
1. **The Survival Gap:** While CraftMagic exports WorldEdit `.schem` files, many survival Minecraft players (SMPs, Hermitcraft-style technical servers) lack server-side operator permissions or WorldEdit (assumption, not measured; validate before relying on it). They rely on client-side **Litematica (`.litematic`)** projections and manual survival gathering.
2. **The "Punch in the Dark" Anxiety:** In-game construction currently relies on a wand right-click that renders only a wireframe particle bounding box (`END_ROD` particles). Players cannot preview structural facades, wall alignments, or door orientations before executing the irreversible build punch.
3. **Single-Player Isolation & Generative Lottery:** Generations currently present a single take-it-or-leave-it output. Once created, builds remain locked inside private user accounts with zero community discovery, social forking, or embeddable showcase capabilities.

This strategic proposal outlines **five prioritized epics** designed to widen CraftMagic’s addressable market (size not yet estimated), eliminate in-game placement errors, introduce instant aesthetic exploration, establish a viral creator commons, and unlock real-time multiplayer architectural planning.

---

### 1.2 Current Product Health Matrix

| Subsystem / Package | Code Location | Architectural State | Current Strengths | Bottlenecks & Strategic Gaps |
| :--- | :--- | :--- | :--- | :--- |
| **Core Engine & Expander** | `packages/core/src/expand/`, `ir/`, `voxels/` | **Excellent** (core unit tests green) | Deterministic 13-component IR expander; 50× smaller than raw voxels; machine-repairable expressions; sub-200ms expansion at 200k blocks. | Block palette frozen at 499 curated blocks (`blocks.gen.json`); lack of survival recipe decomposition tree; single-file export format (.schem). |
| **LEGO Guide & Cartography** | `packages/core/src/guide/`, `apps/web/src/guide/` | **State-of-the-Art** (PR #50 overhauled) | Dynamic camera occlusion calculation (`steps.ts`); 4 axonometric views (`isoRender.ts`); parts callout tray (`CalloutTray.tsx`); interactive builder mode with localStorage progress. | Lacks direct material aggregation into raw survival gathering lists (e.g. logs needed for stairs, sand for glass); cannot export to Litematica material lists. |
| **Web Studio Workbench** | `apps/web/src/studio/`, `editor/`, `architecture/`, `world/` | **High** (`STUDIO-REBUILD.md`) | Unified workbench header, dockable panels, tabbed documents, keyboard shortcuts (Ctrl+K, F8), IndexedDB drafts, robust mode switching. | Single-user state only; no room/presence synchronization; no side-by-side generative comparator; private document silo. |
| **Server & AI Pipeline** | `apps/server/src/generate/`, `agent/`, `db/` | **Stable & Cost-Disciplined** | Prompt caching on the default `claude-sonnet-5` model; budget guard ledger; single-round repair loop; durable agent job anchors (`009_job_regions.sql`). | Single output generation per prompt; no public sharing endpoints (`GET /api/gallery`); WebSocket gateway strictly reserved for Fabric bot agent. |
| **Fabric Mod Runtime** | `mod/src/main/` & `src/client/` (Minecraft 26.2, Java 25) | **Functional Core** | Server-side wand placement; 180-particle wireframe box; quarter-turn rotation; height stepping; clean single-jar bundled distribution. | Client mod (`CraftMagicClient.java`) is a bare stub (wand punch only); lack of in-game ghost voxel projection; HUD lacks visual block alignment preview. |

---

## 2. Evaluation of Strategic Opportunity Vectors

### Vector 1: Litematica (`.litematic`) File Export & Projection Compatibility
* **Current Mechanism:** `packages/core/src/schem/write.ts` writes Sponge v2 `.schem` using `fflate` and `NbtWriter`. Sponge v2 is widely supported by WorldEdit and Axiom, but unsupported natively by vanilla clients.
* **Demographic Reality:** Survival Minecraft players—a large share of builders (assumption, not measured; validate before relying on it)—cannot install WorldEdit on vanilla or multi-player survival servers. Litematica (developed by Masa) is the universal standard for client-side schematic placement, block verification, and survival material gathering.
* **Technical Analysis:** The `.litematic` format is a gzipped NBT file containing a root compound with `Metadata`, `MinecraftDataVersion`, and a `Regions` compound. Crucially, Litematica packs block states into 64-bit integer arrays (`LongArray`) where bit width is calculated as `max(2, ceil(log2(palette_size)))`. Because CraftMagic’s `VoxelGrid` already maintains indexed palettes in YZX order, bit-packing into `BigInt64Array` in isomorphic TypeScript is computationally trivial (estimate: under 50ms for 500k blocks, not yet measured).
* **Strategic Verdict:** **P0 Priority (Epic 1)**. Extremely high leverage with minimal engineering risk. Unlocks the entire survival community.

### Vector 2: In-Game Fabric Mod Ghost Projection Preview & Action-Bar Placement Hints
* **Current Mechanism:** `WandHandler.java` dispatches `ParticleTypes.END_ROD` to trace 12 edges of a bounding cuboid (capped at 180 particles via `MAX_OUTLINE_PARTICLES`).
* **The Problem:** A bounding box does not convey roof pitch, door placement, stair orientation, or terrain clipping. Players placing a 40×30 castle frequently discover after punching that the front portcullis faces into a dirt cliff.
* **Prior Pitfall:** The mod once bundled `fabric-rendering-v1` and `fabric-key-mapping-api-v1` for a hologram and keybinds that were never built (README.md, "One-jar install"). On 26.2, `fabric-rendering-v1`'s model-pipeline mixin died with an `IllegalAccessError` during the initial resource reload and the client crashed on startup. Both modules were removed from the bundle.
* **Architectural Path:** A hologram needs a rendering hook, and the Fabric hooks for it (`WorldRenderEvents.AFTER_TRANSLUCENT`, `HudRenderCallback`) are part of `fabric-rendering-v1`, so a client renderer cannot avoid that module. Two options, in order of preference:
  1. *No new Fabric module:* the server spawns `block_display` entities (vanilla, 1.19.4+) for the pending build, and the existing action bar (`ActionBar.java`) carries the text hints. This needs no rendering hook and no client-side renderer. Whether it stays smooth for large builds is an open question for the spike.
  2. *Re-bundle `fabric-rendering-v1`:* only if option 1 proves insufficient, with the 26.2 `IllegalAccessError` as an explicit risk and a hard gate: the module must pass a clean-install client run (see Phase 2 gate) before it ships. Keybinds (`R`, `F`) would likewise need `fabric-key-mapping-api-v1` to be re-added and its `depends` block read first.
* **Strategic Verdict:** **P1 Priority (Epic 2)**. Closes the physical Minecraft delivery loop and elevates the user experience from guesswork to precision engineering.

### Vector 3: Multi-Variation AI Generation & Stylistic Exploration
* **Current Mechanism:** `generateBuild()` in `apps/server/src/generate/pipeline.ts` executes a single prompt-to-program flow with `DEFAULT_MODEL = 'claude-sonnet-5'` (`pipeline.ts:126`). Per-generation cost is recorded by the spend ledger (`spend.ts`); no figure is quoted here.
* **The Insight:** Users frequently know *what* they want to build (e.g., "a 3-storey watchtower"), but struggle to articulate aesthetic nuances (Nordic Spruce vs Gothic Deepslate vs Desert Sandstone). 
* **The Architectural Advantage:** CraftMagic already separates structure from aesthetics via semantic palettes (`packages/core/src/registry/stylePacks.ts`). Applying a `StylePack` (`applyStylePack()`) is an instantaneous, deterministic, **zero-cost** operation that swaps block roles while preserving stair, slab, and door geometries.
* **Two-Tier Strategy:** 
  1. *Instant Tier:* One prompt generates 1 structural `BuildProgram`, from which the client immediately renders 3 distinct aesthetic variations (e.g., Standard Oak, Gothic Blackstone, Nordic Spruce) in an interactive side-by-side comparator dock at zero additional token cost.
  2. *Form Tier:* Multi-form generative variations using low-effort model routing or parameterized silhouette permutations.
* **Strategic Verdict:** **P0 Priority (Epic 3)**. Delivers immediate user delight, increases prompt satisfaction, and leverages existing core strengths.

### Vector 4: Community Showcase, Public Build Sharing & Embeddable 3D Viewer
* **Current Mechanism:** The `builds` table (`001_initial.sql`) scopes every build to `user_id`. There is no `is_public` flag, no public slug, no social interaction, and no public route.
* **The Lost Loop:** When a creator designs an incredible build in CraftMagic, their only sharing mechanism is exporting a `.schem` or taking a screenshot. CraftMagic loses the viral referral loop.
* **The Solution:** A public creator gallery (`/gallery`) with verified 3D WebGL preview cards, social metrics (likes, views, forks), user profiles, and one-click "Fork & Customize" into the Studio workspace. Furthermore, an embeddable iframe viewer (`/embed/b/:slug`) enables Minecraft server sites, PlanetMinecraft, Reddit, and Discord communities to embed live 3D models.
* **Strategic Verdict:** **P1 Priority (Epic 4)**. Transforms CraftMagic from a solitary utility into a network-driven platform.

### Vector 5: Collaborative / Multiplayer Studio Sessions
* **Current Mechanism:** State in all three studio modes (Build, Architecture, World) is local to the current browser tab and synchronized only on explicit save.
* **Analysis:** Real-time multi-user voxel painting involves substantial conflict resolution overhead. However, **Architecture mode** (`apps/web/src/architecture/`) operates on a discrete 2D floorplan JSON schema of storeys, rooms, and aperture items. Synchronizing 2D room layouts via WebSockets is lightweight and predictable.
* **Strategic Role:** Collaborative floorplan drafting and world-map staging for SMP build teams. 
* **Strategic Verdict:** **P2 Priority (Epic 5)**. High technical moat, scheduled for Phase 3 after single-player and community vectors are maximized.

### Vector 6: Survival-Mode Resource Calculator & Logistics Tree
* **Current Mechanism:** `packages/core/src/guide/steps.ts` computes `MaterialCount` by counting placed blocks and converting to stacks (`stacks = floor(count / 64)`).
* **The Survival Flaw:** Placed blocks do not match harvested resources. Placing 64 `minecraft:oak_stairs` requires crafting from 96 `minecraft:oak_planks`, which requires harvesting 24 `minecraft:oak_log`s. Smelted stone, tinted glass, smooth sandstone, and concrete require distinct crafting and smelting workflows.
* **Synergy with Epic 1:** Pairing a native Survival Gathering Tree (Raw Logs, Sand, Cobblestone, Fuel, Iron) and Shulker Box Logistics Visualizer with Litematica export creates an unbeatable survival companion toolkit.

---

## 3. Prioritized Strategic Epics

```
+-----------------------------------------------------------------------------------+
|                            CRAFTMAGIC STRATEGIC ROADMAP                           |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  EPIC 1: THE SURVIVALIST'S BRIDGE                                 [Priority: P0]  |
|  * Native Litematica (.litematic) NBT Export                                      |
|  * Survival Resource Tree & Shulker Logistics Engine                              |
|                                                                                   |
|  EPIC 2: IN-GAME SPATIAL PRESENCE                                  [Priority: P1]  |
|  * Fabric 26.2 Hologram Ghost Projection Preview                                  |
|  * Action-Bar Placement Hints                                                     |
|                                                                                   |
|  EPIC 3: CREATIVE VELOCITY                                         [Priority: P0]  |
|  * Multi-Style Generative Exploration (Instant 3-Way Aesthetic Branching)          |
|  * Side-by-Side 3D Comparator Dock in Studio                                     |
|                                                                                   |
|  EPIC 4: THE CREATOR COMMONS                                       [Priority: P1]  |
|  * Community Showcase & Public Creator Gallery                                    |
|  * One-Click Social Forking & Embeddable 3D WebGL Viewer                          |
|                                                                                   |
|  EPIC 5: COLLABORATIVE ARCHITECTURE                                [Priority: P2]  |
|  * Real-Time Multi-User Floorplanning Rooms                                       |
|  * Live Presence & Shared SMP Spawn World Staging                                 |
|                                                                                   |
+-----------------------------------------------------------------------------------+
```

---

### Epic 1: The Survivalist's Bridge — Native Litematica (.litematic) Ecosystem & True Resource Gathering Engine
**Strategic Priority:** P0 (Immediate Next Release)  
**Target Personas:** Survival Minecraft Players, Technical Builders (SciCraft/Hermitcraft style), SMP Community Members  
**Value Proposition:** Lets survival players (audience size not yet estimated) instantly take any CraftMagic structure into survival worlds without cheats, server mods, or WorldEdit, backed by exact raw-material harvesting checklists.

#### User Stories
* **US-1.1 (Litematica Export):** *As a survival player on a multiplayer SMP without operator permissions, I want to download my build as a native `.litematic` file, so that I can load it directly into the Litematica client mod and project a holographic ghost in my survival world.*
* **US-1.2 (Crafting Tree Decomposition):** *As a survival gatherer, I want the build guide and export panel to display the raw base resources required (e.g. 142 Oak Logs, 320 Sand, 80 Coal) rather than just crafted blocks, so that I know exactly what to harvest before building.*
* **US-1.3 (Shulker Box Logistics):** *As an end-game survival builder, I want to view my bill of materials grouped by Shulker Boxes (27 stacks per box) and standard Double Chests, with an interactive packing checklist, so that I can organize my construction inventory efficiently.*

#### Technical Architecture & Implementation Details
1. **Litematica Writer (`packages/core/src/schem/litematic.ts`):**
   * Isomorphic TypeScript implementation using existing `NbtWriter` and `fflate`.
   * Maps `VoxelGrid` palette into Litematica's `BlockStatePalette` (`List<Compound>` containing `Name` and optional `Properties`).
   * Implements bit-packing algorithm:
     $$\text{bitsPerEntry} = \max(2, \lceil \log_2(\text{palette.length}) \rceil)$$
   * Packs indices into a `BigInt64Array` (`long[]`) formatted into the `BlockStates` NBT tag.
   * Encapsulates region dimensions in `Regions.Default` with metadata (`TimeCreated`, `TimeModified`, `TotalBlocks`, `EnclosingSize`).
2. **Survival Recipe Resolver (`packages/core/src/registry/recipes.ts`):**
   * Curated directed acyclic graph (DAG) of Minecraft survival crafting and smelting recipes:
     * `minecraft:oak_stairs` $\rightarrow \frac{6}{4}$ `minecraft:oak_planks` $\rightarrow \frac{6}{16}$ `minecraft:oak_log`
     * `minecraft:stone_bricks` $\rightarrow$ `minecraft:stone` $\rightarrow$ `minecraft:cobblestone` + 0.125 coal/smelt
     * `minecraft:glass` $\rightarrow$ `minecraft:sand` + 0.125 coal/smelt
     * `minecraft:smooth_sandstone` $\rightarrow$ `minecraft:sandstone` $\rightarrow$ 4 `minecraft:sand`
   * Computes recursive raw ingredient totals alongside the finished block inventory.
3. **Web UI Integration (`apps/web/src/editor/ExportBar.tsx` & `apps/web/src/guide/`):**
   * Adds "Download .litematic" directly adjacent to "Download .schem".
   * Extends `CalloutTray.tsx` and the materials summary with a toggle: **"Finished Blocks" vs "Raw Gathering Checklist"**.
   * Renders Shulker Box icons with capacity fractions (e.g., `2 Shulkers + 14 Stacks`).

#### Architectural Impact
* `packages/core`: Add `src/schem/litematic.ts`, `src/schem/litematic.test.ts`, `src/registry/recipes.ts`, `src/registry/recipes.test.ts`. Zero breaking changes.
* `apps/web`: Extend `ExportBar.tsx`, `GuidePage.tsx`, `CalloutTray.tsx`.
* `apps/server` & `mod`: Untouched.

---

### Epic 2: In-Game Spatial Presence — Fabric Mod Hologram Preview & Placement Hints
**Strategic Priority:** P1 (Sprint 3–4)  
**Target Personas:** Modded Minecraft Players, Server Admins, Content Creators  
**Value Proposition:** Replaces ambiguous bounding-box particles with a crystal-clear, in-game holographic block ghost, allowing players to rotate, nudge, and verify spatial alignment in real time before building.

#### User Stories
* **US-2.1 (Hologram Projection):** *As a player holding the CraftMagic wand with a pending build, I want to see a translucent, color-accurate holographic ghost of the entire structure in my Minecraft world, so that I can see exactly how the facade, doors, and roof mesh with surrounding terrain.*
* **US-2.2 (Interactive Placement Keybinds) — fallback path only:** *(On the preferred `block_display` path there is no client key mapping: rotation and height keep using the existing wand gestures in `WandHandler.java`, right-click to mark and sneak+right-click to turn or change height.)* As a player positioning a structure, I want to press `R` to cycle quarter-turn rotations, `F` to mirror, and use mouse-wheel / arrow keys to adjust elevation, with the hologram updating instantly on my screen, so that I don't have to fiddle with chat commands or sneak-click camera pitch angles.*
* **US-2.3 (Terrain Collision & Air Cutaways) — fallback path only:** *(Red and amber highlighting needs client-side rendering; the preferred `block_display` path does not provide it.)* As a player placing a building on a hillside, I want the hologram to visually highlight blocks colliding with existing terrain in red and floating overhangs in amber, so that I can adjust the footing before committing the build.*

#### Technical Architecture & Implementation Details
1. **Fabric 26.2 Client-Safe Renderer (`mod/src/client/java/dev/craftmagic/agent/client/`):**
   * Preferred path: server-spawned `block_display` entities show the ghost with no new Fabric module (see Vector 2). The spike must measure entity count and frame time for large builds and set a render distance and block cap from the result.
   * Fallback path: a client renderer using `WorldRenderEvents.AFTER_TRANSLUCENT` with vanilla `RenderType.translucent()`. That event is part of `fabric-rendering-v1`, which crashed the 26.2 client with an `IllegalAccessError` when it was bundled (README.md, "One-jar install"). The fallback ships only if it passes the clean-install gate in Phase 2.
   * Frustum culling and a render distance cap apply to either path; the 60+ FPS target is a goal to be measured, not a result.
2. **Client Placement HUD (`mod/src/client/java/dev/craftmagic/agent/client/hud/`):**
   * Preferred path: text hints through the existing action bar; keeps the existing wand gestures from `WandHandler.java` (right-click to mark, sneak+right-click to turn or change height). Fallback path: a screen overlay rendered via `HudRenderCallback` (also `fabric-rendering-v1`, same gate):
     * Build Name, Dimensions ($W \times H \times L$), Facing Direction (North/East/South/West), Y-Offset.
     * Shortcut hints (fallback path only): `[R] Rotate` · `[F] Mirror` · `[↑/↓] Height Offset` · `[Punch] Build` · `[Esc] Cancel`.
3. **Network Protocol Enhancements (`dev/craftmagic/agent/net/`), fallback path only:** the preferred server-spawned `block_display` path has no client renderer and needs none of these payloads; rotation and height keep using the existing wand gestures (`WandHandler.java`: right-click to mark, sneak+right-click to turn or change height).
   * Server streams compressed schematic voxels to the client upon wand right-click (`SchematicPreviewPayload`).
   * Client transmits updated anchor coordinates (`WandAnchorUpdatePayload`) during keybind adjustments.
   * Wand punch remains authoritative on the server: the server validates that the final anchor matches the player's line of sight and permission boundaries before initiating the `BuilderBot` task.

#### Architectural Impact
* `mod`: Preferred path adds server-side hologram entity management in `mod/src/main/` and extends `ActionBar.java`. The fallback path upgrades `CraftMagicClient.java` from a stub into a client visualizer (`HologramRenderer.java`, `PlacementHud.java`, keybind registration) and re-adds `fabric-rendering-v1` and `fabric-key-mapping-api-v1` to the bundle.
* `packages/core` & `apps/server`: Modest protocol payload additions in `packages/core/src/protocol/agent.ts`.

---

### Epic 3: Creative Velocity — Multi-Style Exploration & Intelligent Architectural Variations
**Strategic Priority:** P0 (Sprint 1–2)  
**Target Personas:** Architectural Creators, Casual Builders, Rapid Prototypers  
**Value Proposition:** Eliminates prompt hesitation and generative "roulette" by offering instant, side-by-side aesthetic variations from a single prompt at zero extra token cost, backed by intelligent multi-form branching.

#### User Stories
* **US-3.1 (Instant 3-Way Style Branching):** *As a creator generating a build from a prompt, I want CraftMagic to immediately present 3 distinct architectural styles (e.g. Classic Medieval, Nordic Spruce, Gothic Blackstone) side by side, so that I can choose the aesthetic that best fits my world.*
* **US-3.2 (Synchronized 3D Comparator Dock):** *As a user evaluating variations, I want a multi-canvas dock in the Studio where rotating one model synchronously rotates the other two, so that I can inspect details from identical camera angles.*
* **US-3.3 (One-Click Style Commitment & Fork):** *As a user who has chosen a favorite variation, I want to click "Select & Open in Studio" to begin fine manual editing, with the option to save the other variations to my library as branch alternatives.*

#### Technical Architecture & Implementation Details
1. **Deterministic Aesthetic Branching Engine (`apps/web/src/studio/variation.ts`):**
   * Takes the emitted `BuildProgram` from the existing `POST /api/generations` flow (progress and the program arrive over `GET /api/generations/:id/events`).
   * Automatically invokes `applyStylePack(program, pack)` across 3 contextually contrasting packs (selected based on prompt keywords or curated defaults: e.g. `nordic`, `gothic`, `desert`, `blossom`).
   * Expands the programs client-side in parallel Web Workers using existing worker meshing.
   * **Cost Impact:** Exactly 0 additional API tokens. Target: 3 variations expand and mesh in under 400ms combined (not yet measured; this is the Phase 1 gate).
2. **Studio 3D Comparator Dock (`apps/web/src/studio/ComparatorDock.tsx`):**
   * Renders a 3-column comparative viewport.
   * Coordinates Three.js orbit camera controllers through a shared event bus (`CameraSyncBus`): orbiting or zooming any viewport synchronizes azimuth, elevation, and target across all three panels.
   * Includes structural metrics cards under each variation: Block Count, Palette Distribution, Dominant Materials, and Guide Step Count.
3. **Advanced Generative Silhouette Branching (Server Phase):**
   * For users requesting structural/layout variations (not just palettes), the server introduces a new route under `/api/generations/` (e.g. `POST /api/generations/variations`) supporting concurrent low-effort Claude passes (`effort: 'low'`) with distinct temperature seeds, gated by user subscription quota and spend ledger checks.

#### Architectural Impact
* `packages/core`: Add style pack contextual recommender in `packages/core/src/registry/stylePacks.ts`.
* `apps/web`: Create `ComparatorDock.tsx`, update `StudioPage.tsx`, `studio/workspace/WorkspaceFrame.tsx` and `studio/workspace/documents.ts`.
* `apps/server`: Add the variation route alongside the existing `/api/generations` routes in `apps/server/src/generate/routes.ts`.

---

### Epic 4: The Creator Commons — Public Showcase, Social Forking & Embeddable 3D Viewer
**Strategic Priority:** P1 (Sprint 3–4)  
**Target Personas:** Minecraft Content Creators, Community Members, Build Teams, Server Marketers  
**Value Proposition:** Unlocks organic viral distribution by allowing creators to publish builds to a public gallery, share clean web links with interactive 3D embeds, and enable any visitor to "Fork & Edit" into their own library.

#### User Stories
* **US-4.1 (Public Gallery & Discovery):** *As a Minecraft builder, I want to browse a curated public gallery of community builds filtered by category (Castles, Houses, Spawns, Redstone Enclosures), block count, and style, so that I can find inspiration for my world.*
* **US-4.2 (One-Click Fork into Studio):** *As a creator browsing the gallery, I want to click "Fork & Customize", creating an independent copy in my private library with full edit history and parametric sliders intact, attributing the original creator.*
* **US-4.3 (Embeddable Interactive 3D Viewer):** *As a server owner or blogger, I want to embed an interactive 3D WebGL viewer of my CraftMagic build onto my website or forum post using an `<iframe>`, so that visitors can inspect my build without installing Minecraft.*
* **US-4.4 (Creator Vanity URLs):** *As an author, I want a permanent, beautiful public URL for my build (`craftmagic.dev/b/iron-keep-v2`) with OpenGraph preview cards showing the 3D rendered model.*

#### Technical Architecture & Implementation Details
1. **Database Schema Migration (`012_public_gallery.sql`):**
   ```sql
   ALTER TABLE builds 
     ADD COLUMN is_public boolean NOT NULL DEFAULT false,
     ADD COLUMN slug text UNIQUE,
     ADD COLUMN forked_from_id uuid REFERENCES builds(id) ON DELETE SET NULL,
     ADD COLUMN fork_count int NOT NULL DEFAULT 0,
     ADD COLUMN view_count int NOT NULL DEFAULT 0,
     ADD COLUMN tags text[] NOT NULL DEFAULT '{}';

   CREATE INDEX builds_public_gallery_idx ON builds(is_public, created_at DESC) 
     WHERE is_public = true;
   CREATE INDEX builds_slug_idx ON builds(slug);
   ```
2. **Public API Routes (`apps/server/src/gallery/`):**
   * `GET /api/gallery`: Paginated search with tags, sorting (`trending`, `recent`, `most_forked`).
   * `GET /api/gallery/:slug`: Returns public build metadata, compiled program, and thumbnail preview.
   * `POST /api/builds/:id/publish`: Generates a collision-resistant human-readable slug and publishes.
   * `POST /api/builds/:id/fork`: Clones build, increments `fork_count`, assigns `forked_from_id`.
3. **Embeddable Viewer Surface (`apps/web/src/embed/EmbedPage.tsx`):**
   * Ultra-lightweight standalone route stripped of editor toolbars and docks.
   * Bounded Three.js canvas with auto-rotation, orbit controls, wireframe toggle, and a prominent "Made with CraftMagic — Fork this Build" badge driving signups.

#### Architectural Impact
* `apps/server`: New migration `012_public_gallery.sql`, routes in `gallery/routes.ts`, and OpenGraph meta tag injection for social link previews.
* `apps/web`: New `/gallery` and `/b/:slug` pages; embed route `/embed/b/:slug`.

---

### Epic 5: Collaborative Architecture — Real-Time Shared Studio & Multiplayer World Planning
**Strategic Priority:** P2 (Sprint 5–6)  
**Target Personas:** Build Teams, SMP Server Staff, Architecture Duos, Educational Groups  
**Value Proposition:** Enables multiple creators to synchronously plan floorplans, adjust storeys, and coordinate world placements in real time within a shared room session.

#### User Stories
* **US-5.1 (Shared Architecture Room Session):** *As a build team lead, I want to create a shared Architecture room link (`/studio?mode=arch&room=dragon-keep`), so that my co-builder can join and edit the same floorplan with me simultaneously.*
* **US-5.2 (Live Multi-User Cursors & Presence):** *As a collaborator on a 2D floorplan, I want to see my teammate's colored cursor, active tool, and selected room in real time, so that we don't accidentally edit the same partition.*
* **US-5.3 (Synchronous Floorplan Compilation):** *As rooms and doors are adjusted by any participant, I want the compiled 3D model preview to update live for all participants in the room.*

#### Technical Architecture & Implementation Details
1. **Real-Time Room Gateway (`apps/server/src/collab/`):**
   * Extends Fastify's existing `@fastify/websocket` infrastructure to host `/collab/room/:roomId`.
   * Manages room lifecycle, participant presence, and message broadcasting.
2. **Delta Synchronization Model:**
   * Architecture mode's document (`plan`) is structured as an immutable JSON tree of storeys, rooms, free partitions, and apertures (`apps/web/src/architecture/storage.ts`).
   * Floorplan mutations are dispatched as discrete, idempotent operations:
     * `ROOM_ADD`, `ROOM_MOVE`, `ROOM_RESIZE`, `APERTURE_INSERT`, `STOREY_SELECT`.
   * Fastify relays operations to connected clients with an incrementing sequence epoch.
3. **Client Session Integration (`apps/web/src/architecture/useCollabSession.ts`):**
   * Integrates seamlessly into the existing Studio architecture dock layout.
   * Displays peer avatars in the Studio header with presence status.
   * Remote user cursors rendered as SVG pointers on the 2D grid plane.

#### Architectural Impact
* `apps/server`: Add `apps/server/src/collab/` WebSocket room broker with in-memory session state (Redis only if the server is scaled out).
* `apps/web`: Add collaborative state hooks in `apps/web/src/architecture/` and presence indicators.

---

## 4. Recommended Sequencing & Multi-Phase Execution Plan

The execution sequence is structured into three discrete phases, designed to balance immediate demographic impact, technical risk, and foundational dependencies.

```
PHASE 1: Foundation & Survival (Weeks 1-4)
├── Epic 1: Litematica (.litematic) Export & Survival Resource Gathering Tree
└── Epic 3A: Instant 3-Way Aesthetic Variations & Studio Comparator Dock

PHASE 2: Spatial Precision & Community Hub (Weeks 5-8)
├── Epic 2: Fabric Mod Hologram Ghost Projection & Action-Bar Placement Hints
└── Epic 4: Creator Commons Gallery, Social Forking & Embeddable 3D Viewer

PHASE 3: Generative Depth & Social Studio (Weeks 9-12)
├── Epic 3B: Advanced Generative Multi-Form Variations (Low-Effort LLM Routing)
└── Epic 5: Collaborative Architecture Multiplayer Rooms & Live Presence
```

---

### Phase 1: Foundation & Survival Democratization (Weeks 1–4)
* **Objective:** Expand CraftMagic’s addressable market to survival Minecraft players while improving prompt satisfaction (no baseline or target measured yet; define the metric before the phase starts).
* **Workstreams:**
  * **Core Team (Linus / Felix):** Implement `packages/core/src/schem/litematic.ts` with NBT bit-packing and complete unit tests (`litematic.test.ts`). Build survival crafting DAG resolver in `packages/core/src/registry/recipes.ts`.
  * **Frontend Team (Grace / Maya):** Build "Raw Gathering Checklist" and Shulker box visualizer in `apps/web/src/guide/` and `ExportBar.tsx`. Implement instant 3-way aesthetic branching with `applyStylePack` and the Three.js synchronized `ComparatorDock.tsx`.
* **Deliverables:**
  * One-click `.litematic` file download from Studio and Guide pages.
  * Comprehensive raw material gathering lists (Logs, Sand, Cobblestone, Fuel) with stack/shulker counts.
  * Interactive 3-way aesthetic variation chooser on generation completion.
* **Verification Gate:**
  * Clean verification of exported `.litematic` in Minecraft using official Litematica mod.
  * Zero-cost performance proof: 3 variations expand and mesh in under 400ms combined.

---

### Phase 2: In-Game Spatial Precision & Community Discovery (Weeks 5–8)
* **Objective:** Eliminate in-game placement anxiety and establish a viral referral loop.
* **Workstreams:**
  * **Mod & Runtime Team (Devon / Linus):** Implement the ghost projection (preferred: server-spawned `block_display` entities; fallback: a client renderer on `WorldRenderEvents.AFTER_TRANSLUCENT`, which needs `fabric-rendering-v1`). The preferred path keeps the existing wand gestures from `WandHandler.java` and the action-bar hints; placement hints and keybinds (`R`, `F`, arrows) are fallback path only, noting that keybinds need `fabric-key-mapping-api-v1`.
  * **Fullstack & UI Team (Felix / Grace / Morgan):** Execute database migration `012_public_gallery.sql`. Build `/gallery` and `/b/:slug` pages, public publish modal, one-click forking flow, and lightweight `/embed/b/:slug` 3D viewer.
* **Deliverables:**
  * Fabric mod with true in-game holographic block ghost preview before building.
  * Public community gallery with search, tags, and 3D preview cards.
  * Embeddable 3D iframe widget for external web distribution.
* **Verification Gate:**
  * Verified Fabric 26.2 client run on a real install with nothing else in `mods/` (not the dev `runClient`, which puts all of Fabric API on the classpath): zero `IllegalAccessError` or startup crashes. Mandatory if `fabric-rendering-v1` or `fabric-key-mapping-api-v1` is re-bundled.
  * Embeddable widget loads and renders in under 500ms on external origins with zero authentication.

---

### Phase 3: Generative Depth & Synchronous Collaboration (Weeks 9–12)
* **Objective:** Build durable long-term network effects through multiplayer planning and multi-candidate generative modeling.
* **Workstreams:**
  * **Backend & Infra Team (Linus / Devon):** Implement Fastify WebSocket collaboration gateway (`apps/server/src/collab/`). Develop multi-candidate generation pipeline with cost-ledger safeguards.
  * **Frontend Team (Grace / Maya / PrimeTime):** Implement `useCollabSession` in Architecture mode with multiplayer SVG cursor overlays and synchronized plan compilation.
* **Deliverables:**
  * Real-time collaborative 2D floorplan drafting room sessions.
  * Multi-form structural AI generation options for advanced tiers.
* **Verification Gate:**
  * Multi-client browser tests verifying concurrent room edits converge with zero loss of wall/aperture data.

---

## 5. Engineering Team Allocation & Ownership

To maximize velocity and eliminate cross-task file conflicts, engineering assignments are mapped directly to team specializations:

| Engineer | Title / Charter | Primary Assigned Workstream |
| :--- | :--- | :--- |
| **Linus** | Backend Developer | Lead on `packages/core/src/schem/litematic.ts`, `recipes.ts`, and server gallery APIs (`012_public_gallery.sql`). |
| **Grace** | Frontend Developer | Lead on `apps/web` Studio integration, `ComparatorDock.tsx`, `ExportBar.tsx`, and Shulker logistics UI. |
| **Felix** | Fullstack Engineer | Lead on `/gallery` frontend, embeddable WebGL widget (`/embed/b/:slug`), and forking pipeline. |
| **Devon** | DevOps & Systems | Lead on Fabric mod client hologram renderer (`mod/src/client/`), 26.2 JVM headless verification, and Gradle pipelines. |
| **Maya** | Frontend Engineer | Lead on LEGO Guide survival checklist enhancements, `CalloutTray.tsx` extensions, and responsive mobile dock layouts. |
| **Quinn** | QA & Code Reviewer | Owns automated verification scripts (`tools/verify-litematic.mjs`, `tools/verify-gallery.mjs`), test-database harnesses, and WCAG compliance. |
| **PrimeTime** | Specialist Engineer | Implementation of complex architectural algorithms, 3D camera sync bus, and collaborative delta operational transforms. |
| **Integrator** | Review & Landing | Rigorous review of all staged PRs, ensuring clean mergeability, branch integrity, and zero regressions against P0–P5 contracts. |

---

## 6. Risk Assessment & Mitigation Strategies

| Risk Factor | Probability | Impact | Mitigation Strategy |
| :--- | :---: | :---: | :--- |
| **Fabric 26.2 Mixin & Shader Volatility** | Medium | High | Any client rendering hook (`WorldRenderEvents.AFTER_TRANSLUCENT`, `HudRenderCallback`) lives in `fabric-rendering-v1`, whose bundling crashed the 26.2 client with an `IllegalAccessError` (README.md, "One-jar install"). Prefer server-spawned `block_display` entities, which need no rendering module. If the module is re-bundled, treat the crash as a known risk and gate release on a clean-install client run with nothing else in `mods/`. |
| **Litematica Bit-Packing Desynchronization** | Low | High | Validate bit-packing against Masa's reference implementation. Lock implementation with round-trip unit tests reading back written `.litematic` files in `packages/core/src/schem/litematic.test.ts`. |
| **AI Generation Token Cost Escalation** | Medium | Medium | Prioritize Epic 3's zero-cost semantic palette branching (`applyStylePack`) for default user variation flows. Gate multi-candidate LLM calls behind user quotas and strict spend ledger checks. |
| **Collaborative State Divergence** | Medium | Medium | Limit initial collaboration scope to 2D Architecture mode (discrete SVG room/door entities), avoiding high-frequency voxel painting synchronization until Phase 3. |
| **Community Content Moderation & Abuse** | Low | Medium | Enforce authentication for publishing; implement automated profanity and malicious block-pattern filters; add community reporting flags and rate-limiting on public slugs. |

---

## 7. Strategic Success Metrics (KPIs)

The strategic impact of this roadmap will be measured against five unambiguous business and product indicators:
1. **Survival Export Share:** >40% of all user downloads originating from the new `.litematic` and Survival Gathering Checklist options within 30 days of release.
2. **Placement Success Rate:** >95% reduction in player-initiated `/craftmagic cancel` or wand undo commands, directly validating the effectiveness of the in-game hologram preview.
3. **Generative Conversion:** >60% of generation sessions utilizing the 3-Way Comparator Dock to select an initial architectural style, demonstrating increased creative direction and satisfaction.
4. **Organic Referral Traffic:** >25% of new account signups originating from public gallery links (`/b/:slug`) and embeddable 3D viewers on external sites.
5. **Team Collaboration Adoption:** >15% of Architecture floorplan documents shared with at least one active collaborator session.

---

## 8. Conclusion & Immediate Next Steps

CraftMagic has built a magnificent, technically differentiated foundation. By executing this prioritized roadmap:
1. **Epic 1** immediately captures the survival Minecraft community, bridging the single largest distribution chasm in the game's ecosystem.
2. **Epic 2** completes the tactile in-game experience, providing creators with spatial confidence before executing a build.
3. **Epic 3** transforms AI generation from a passive lottery into a rapid aesthetic design studio at zero added token cost.
4. **Epic 4** unleashes network effects through a community gallery and viral embeddable 3D models.
5. **Epic 5** establishes CraftMagic as the definitive collaborative platform for multiplayer Minecraft architecture.

**Immediate Next Action:** Hand off Epic 1 (Litematica Export & Survival Resource Gathering Tree) and Epic 3A (Instant 3-Way Aesthetic Variations) to Ada and the engineering team for Phase 1 execution.
