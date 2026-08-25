# CraftMagic

Describe a Minecraft build in words. Get it back as a 3D model you can edit, then export it
three ways: a WorldEdit schematic, a LEGO-style instruction booklet, or a builder bot that
walks into your world and constructs it.

## How it works

The AI does not generate voxels. It generates a **build program** — a small parametric
description (boxes, roofs, window grids, arches, a semantic palette) whose coordinates are
expressions like `max-1`, `center`, `50%`, `$floors*4` rather than fixed numbers. A
deterministic expander in `packages/core` bakes that program into a voxel grid.

That single choice is why resizing works: change the size and re-expand, and the walls stay
walls instead of drifting into the middle of the building. It also keeps AI output about 50×
smaller than raw voxels, makes errors machine-repairable, and lets the expander — not the
model — compute the blockstates (stair `facing`, door `hinge`) that language models
reliably get wrong.

## Layout

| Path | What it is |
|---|---|
| `packages/core` | Shared, isomorphic: IR + expander, block registry, `.schem` writer, guide logic, agent protocol |
| `apps/server` | Fastify — API, auth, Claude pipeline, agent WebSocket gateway; also serves the built frontend |
| `apps/web` | React + Vite + three.js editor and site |
| `mod` | Fabric mod for Minecraft 26.2 (Gradle, outside the npm workspaces) |
| `tools/registry-gen` | Dev-only. Generates the block registry from Mojang's data generator |

## Web development

```bash
npm install
npm run build          # core -> web -> server
npm run dev            # server on :3016, serving the built frontend
npm run dev:web        # optional: Vite dev server on :5183, proxying /api and /agent
npm test               # core unit tests
```

`node tools/ws-smoke.mjs [origin]` checks the agent WebSocket endpoint. Point it at a
deployed origin to prove upgrades survive the reverse proxy:

```bash
node tools/ws-smoke.mjs wss://craftmagic.example.com
```

## Database

Local Postgres runs from portable binaries in `C:\Users\tobia\tools\pgsql` as a user-mode
cluster — no Windows service and no admin rights. It listens on **55432**, so it cannot
collide with any other Postgres on the machine. Data lives in `.pgdata/` (gitignored).

```powershell
./tools/pg.ps1 init     # once: create cluster, role and database
./tools/pg.ps1 start
./tools/pg.ps1 status
./tools/pg.ps1 psql
./tools/pg.ps1 stop
./tools/pg.ps1 destroy  # delete the cluster entirely
```

```
DATABASE_URL=postgres://craftmagic:craftmagic@localhost:55432/craftmagic
```

Two Windows-specific traps are worked around in that script, and both will bite again if
someone "simplifies" it. Native tools write ordinary warnings to stderr, which
`$ErrorActionPreference = 'Stop'` turns into fatal `NativeCommandError`s — so the script
checks exit codes instead. And the long-lived `postgres` process inherits whatever stdout
handle `pg_ctl` was given, so *any* form of waiting on `pg_ctl start` (a pipe, a redirect
file, `Start-Process -Wait`) blocks forever on a stream that never closes; the script
launches it detached and polls `pg_isready` instead.

## Mod development

Minecraft 26.2 requires **Java 25**. This machine has no system-wide JDK, so a portable
Temurin lives at `C:\Users\tobia\tools\jdk25` and `mod/gradle.properties` points Gradle at
it. The `gradlew` launcher reads `JAVA_HOME` *before* it reads that file, so it must be set
on the command line too:

```bash
cd mod
JAVA_HOME="C:/Users/tobia/tools/jdk25" ./gradlew build      # -> build/libs/craftmagic-0.1.0.jar
JAVA_HOME="C:/Users/tobia/tools/jdk25" ./gradlew runServer  # headless dev server
JAVA_HOME="C:/Users/tobia/tools/jdk25" ./gradlew runClient  # dev client
```

### Placing a build: the wand

`/wand` hands the player a stick. **Right-click** marks a spot and draws the footprint in
particles, **sneak + right-click** turns it a quarter, and **punching the air** builds it
there. Nothing is placed until the punch, so aiming is free and repeatable — which is the
whole reason it exists. `/craftmagic build` and `/craftmagic place <x> <y> <z>` still work,
for the console, command blocks and anyone who would rather type.

Punching a *block* or a mob reaches the server as an ordinary Fabric interaction event.
Punching *air* does not — vanilla sends only a swing animation — so the client relays a
`craftmagic:wand_punch` payload that carries nothing but the fact of the punch. The marked
spot lives on the server and never travels, so a modified client cannot ask for a build at
coordinates it never marked.

```bash
JAVA_HOME=... ./gradlew verifyPlacement   # the centring math, at every rotation, with no game
```

### Version pins

Everything is pinned in `mod/gradle.properties`, cross-checked against
<https://fabricmc.net/develop>:

| | |
|---|---|
| Minecraft | 26.2 (DataVersion 4903) |
| Fabric Loader | 0.19.3 |
| Fabric API | 0.158.0+26.2 |
| Loom / Gradle | 1.17 / 9.5.1 |
| Java | 25 |

**Mappings:** 26.2 has no Yarn mappings — Yarn stopped at 1.21.11. Loom 1.17 defaults to
Mojang's own mappings with Fabric renames, so class and method names differ from older
tutorials (`MinecraftServer.getServerVersion()`, not `getVersion()`). When porting code
found online, check the symbol against the remapped jar rather than trusting the snippet:

```bash
javap -cp ~/.gradle/caches/fabric-loom/minecraftMaven/net/minecraft/\
minecraft-common-deobf/26.2/minecraft-common-deobf-26.2.jar net.minecraft.server.MinecraftServer
```

### One-jar install

**Players do not need to install Fabric API separately.** The mod bundles the five modules it
uses — `fabric-api-base`, `fabric-command-api-v2`, `fabric-lifecycle-events-v1`,
`fabric-events-interaction-v0` and `fabric-networking-api-v1` (the last two for the wand) — via
Gradle `include` / Jar-in-Jar, so `fabric.mod.json` declares no `fabric-api` dependency. Anyone
already running the full Fabric API keeps whichever version is higher.

Two rules, each learned from a shipped bug:

**Bundle only what the bytecode uses.** The list once carried `fabric-rendering-v1` and
`fabric-key-mapping-api-v1` for the hologram preview and its keybinds — features the roadmap
intends but that were never built. Bundling is not free: every module injects its mixins into
the game whether the mod calls it or not, and on 26.2
`fabric-rendering-v1`'s model-pipeline mixin died with an `IllegalAccessError` during the
initial resource reload. The client crashed on startup because of a renderer nothing used.
Check before adding:

```bash
javap -p -c <extracted classes> | grep -oE 'net/fabricmc/fabric/api/[a-zA-Z0-9/]+' | sort -u
```

**`include` is not transitive.** It bundles exactly the artifact named and nothing that
artifact depends on. Every module above declares `"fabric-api-base": "*"` as a hard
dependency, and `fabric-events-interaction-v0` also names `fabric-networking-api-v1`; shipping
without either made the jar refuse to load for anyone who did not already have the full
Fabric API. Read a module's `depends` block before adding it:

```bash
unzip -p <module>.jar fabric.mod.json | grep depends
```

Neither bug was visible from this repo. `runClient` and `runServer` put all of Fabric API on
the dev classpath, so every in-game verification passed against a runtime the shipped jar never
sees. The only verification that means anything is a **real Fabric install with nothing else in
`mods/`**:

```bash
curl -L -o server.jar https://meta.fabricmc.net/v2/versions/loader/26.2/0.19.3/1.1.2/server/jar
mkdir mods && cp <the built jar> mods/ && echo "eula=true" > eula.txt
java -jar server.jar nogui      # every module should appear nested under "craftmagic"
```

That server is also the best target for `tools/verify-ingame.mjs`: point it at the clean
server's RCON and the whole loop runs against the artifact players actually download.

## Block registry

`packages/core/src/registry/blocks.gen.json` holds 499 curated build blocks with their
state properties, defaults and a display colour. **Never hand-edit it** — regenerate with
`tools/registry-gen`, which reads two authoritative sources and redistributes neither:

- Mojang's own data generator, for block ids, state properties and defaults:
  `java -DbundlerMainClass=net.minecraft.data.Main -jar <server.jar> --reports`
- The locally installed client jar's textures, averaged to one RGB per block. Only the
  derived colour is written out; no Mojang art is copied. Texture alpha also decides the
  `transparent` flag, which is more reliable than maintaining a list by hand.

Which blocks are included is defined in `curated.mjs` as families and suffix patterns,
expanded and then filtered against the report — so irregular families need no special
cases, and non-existent combinations simply fall out.

## Status

**M0 (scaffold) — complete.** The monorepo builds, the server runs and accepts WebSocket
upgrades over the internet, and the mod compiles and loads on a real 26.2 dedicated server.

**M1 (core + viewer) — complete**, 137 tests green:

- Coordinate expressions, the 499-block registry, and the expander with all 13 component
  types, group transforms, fill patterns and detail ops.
- Three sample programs (`packages/core/src/samples`) that double as fixtures and as worked
  examples of resize-safe anchoring.
- 3D viewer: worker-based culled chunk meshing with ambient occlusion, orbit/pan/zoom, a
  clipping-plane layer slider, DDA voxel picking, and a param slider that re-expands the
  program live — that slider *is* smart resize.
- Performance: a 200×60×200 build (265k blocks) expands in ~190 ms; the 202k-block stress
  fixture meshes 389k quads in ~114 ms, and scrubbing layers re-meshes nothing.

**Editing tools — done.** Eight of them: place, erase, flood fill, box (fill / replace /
hollow / clear / copy), palette swap, line, stamp and pick, on the number keys `1`–`8`, with
undo/redo on Ctrl+Z / Ctrl+Shift+Z. Each tool is a pure function of the grid and a pick that
returns an `EditOp` — it never touches the renderer — so the caller owns applying and
recording, and every tool is testable without a DOM.

Four of those exist because clicking one block at a time is not building:

- **A brush**, round or square, radius 0–8, on `−` and `+`. It shares one module with
  **Shift-drag strokes**, because both are the same problem: a set of cells that has to
  become *one* `EditOp`. A drag that pushed an op per pointer move would need eighty presses
  of Ctrl+Z to take back one stroke, and the byte ceiling below would evict the start of a
  stroke still visible on screen.
- **A line** between two picked cells, walked with integer 3D Bresenham so the far end lands
  exactly where it was clicked — beams, frames, rooflines.
- **A clipboard**: copy a region with the box tool, then stamp it, rotating with `R` and
  mirroring with `M`. A clip carries its own palette of block *refs* rather than indices,
  which is what lets it be pasted into a build numbered differently and rotated at all —
  indices cannot be rotated, and `facing=north` has to become `facing=east` with the
  geometry or the staircase turns and keeps facing the old wall.
- **Alt+click picks** the block under the pointer from any tool, and the picker keeps the
  last eight blocks as swatches. Matching a block already in the build used to mean reading
  its name off the readout and typing it back into a search box.

Nothing destructive happens unannounced: the canvas outlines what the next click would
change — the brush's actual footprint, the line's path, the box between the two corners, the
clipboard where it would land — and the readout under the build carries the cell count,
which is the part that is hard to judge by eye. Past 800 cells the outline collapses to a
bounding box, since it is rebuilt on every pointer move.

Two limits are deliberate rather than defensive. The flood fill stops at **100,000 cells**
and says so: a stone shell on a 500k-block build is one connected region, and an unbounded
flood there freezes the tab on what may have been a stray click. The undo stack caps at
**100 ops or 64 MB**, whichever binds first — a depth limit alone cannot bound memory when
one box fill is 10 MB, and a byte limit alone lets ten thousand single-voxel pokes make
every undo a linear walk. A stroke is capped at **250,000 cells** and a clip at **2,000,000**,
for the same reason in the other direction: a clip is held for the whole session and copied
again by every rotation.

The interesting conflict is with the param slider. Manual edits write voxels; the slider
re-derives them, so moving it would silently delete the edits. The first edit marks the
build **detached**, and from then on anything that re-expands asks first — the pre-edit
voxels and the palette length are kept, so *revert* is a real answer rather than a reload.
Growing the palette to hold a newly placed block does **not** reload the world: a freshly
appended slot cannot be in any existing mesh, so `VoxelWorld.setPalette` widens the worker's
colour tables in place instead of re-meshing 400 chunks.

The layer slider gained a second cut: **`I` isolates** the layer under the slider so the
build reads as one floor plan at a time, and `[` / `]` step the cut a layer at a time. Both
are still clipping planes rather than a re-mesh, and the picker is told about both cuts, so
a click cannot land on a block nobody can see. Four camera presets sit beside it, because an
orbit camera is very good at ending up somewhere with no way back. `?` lists every shortcut,
which is the only way anyone was ever going to find Alt+click.

```bash
node tools/verify-edit.mjs cottage out/verify-edit.png   # real clicks over CDP
node tools/verify-edit.mjs field   out/verify-field.png  # same, on the 202k-block build

# Any Chromium will do; CM_BROWSER points at one, CM_BROWSER_FLAGS adds machine-specific
# flags (a container running as root needs --no-sandbox).
CM_BROWSER=/opt/pw-browsers/chromium CM_BROWSER_FLAGS=--no-sandbox node tools/verify-edit.mjs
```

That driver clicks the canvas for real — pointer events, DDA pick, op, re-mesh, HUD — and
checks the block count moves, Ctrl+Z puts it back, the fill spreads, the box and the swap
report what they touched, a wide brush removes more than one block, a Shift-drag lands as a
single undo step, a line is one op however long it is, Alt+click samples without editing,
a copied region stamps back rotated, `[` and `I` cut and isolate a layer, the shortcut sheet
opens and closes, the re-expansion guard appears, revert restores the build exactly, and
Ctrl+Z inside the generation prompt does *not* undo. On a 100k-cell fill the op costs
~8 ms to build and ~2.5 ms to undo through `VoxelWorld`; a 1.25M-cell box op is 10 MB and
applies in ~34 ms.

**M3 (exports) — schematic download done.** The editor's Export panel writes a
WorldEdit-compatible `.schem` **entirely in the browser** — `packages/core` is isomorphic
precisely so the server never has to touch it. Verified the whole way through: a button
click in headless Edge produced a real file on disk, which Minecraft's own parser then read
back with every blockstate resolving.

```bash
node tools/verify-download.mjs cottage out/from-browser   # click the button for real
cd mod && JAVA_HOME=... ./gradlew verifySchematic -Pschem=../out/from-browser/oak-cottage.schem
```

The panel also exports the **program JSON**. Worth having as a separate artifact: the
`.schem` is the finished object, the program is the recipe — a few kilobytes instead of a
few hundred, with its coordinate expressions intact, so it can be re-expanded at any size.

**The build guide** lives at `/guide?build=<id>&p.<name>=<value>` — the editor's URL with a
different path, so a guide always prints the build you were looking at, at the params you had
set. Nothing is stored: the expander rebuilds the grid and `buildGuide` re-segments it, so a
guide can never drift from the program it describes.

Each step shows a top-down layer plan (new blocks outlined, earlier ones in the same layer at
45%, the layer below ghosted at 20%) beside an isometric render of the build *after* that
step, so the reader watches it accumulate. Print with Ctrl+P — the print stylesheet flips to
an ink-friendly light page and keeps step cards off page breaks. The 43-step cottage guide
renders in ~0.6s.

**Steps are named, not numbered.** `BuildGuideDesignSystem` (`packages/core/src/guide/
design-system.ts`) is the policy behind every guide: how big a step may be, whether one may
mix parts, where the difficulty bands fall, and what each part is *called*. A step reads
"Step 13 — Walls" rather than "y = 1, part 6 of 6", and the cover carries a bill of parts —
"Foundation, Walls, Frame (north-west), South windows, Roof" — before the bill of materials.

That needs the expander to say which component drew which block, so `expand(program, {
provenance: true })` returns an `origin` array parallel to `grid.voxels` plus the `parts` it
indexes. It is opt-in because the editor re-expands on every frame of a slider drag and would
pay for something it never reads; on the 200k-block stress build it costs ~6ms of 48ms and a
second `Uint16Array`. Two properties are worth knowing: a `repeat` transform's children stay
*one* part, so a hundred identical towers are one line and not a hundred, and a part is
measured by what survived overpainting, so a wall hidden behind a later wall reports zero
blocks and is dropped rather than named in a step nobody can see.

Naming deliberately lives in the design system rather than in the expander. What a part *is*
— a `hollow_box` drawing `wall_primary` — is settled at expansion; what it is *called*
depends on the build's proportions and on what else shares its name, which is why four
identical corner posts come out as "Frame (north-west)" and friends. A build with no program
behind it — a hand-edited grid from the library — has no parts, and the guide falls back to
naming steps by layer rather than inventing them.

The visual half is `apps/web/src/guide/tokens.css`: colour *roles*, a closed type scale and a
six-step spacing rhythm, with `print.css` written entirely against them. That is what keeps
the `@media print` block short — the booklet is repainted for paper by redefining eight
values, not by restating a hundred rules.

```bash
node tools/shot.mjs "http://localhost:3016/guide?build=cottage" guide.png ".guide" "data-ready" "1"
node tools/print-check.mjs "http://localhost:3016/guide?build=cottage" out/guide.pdf
```

**Check printing with `print-check.mjs`, not with a screenshot.** It drives CDP
`Page.printToPDF` — the same pipeline as Ctrl+P — and both of the guide's worst bugs were
invisible on screen: a `max-width: 46rem` query that fired on A4 (703px once margins are
removed) and stacked the panels one step per page, and a stylesheet-order problem that
printed the page black. Route-level CSS is bundled *before* the global stylesheet, so
`@media print { :root { … } }` loses to the dark `:root`; print overrides live on `.guide`
instead — now in `tokens.css`, which redefines the roles there — where custom properties
still inherit. The cottage guide is 24 A4 pages.

Guides cap at `MAX_PRINTABLE_STEPS = 400`. The 202,700-block stress build segments into
5,423 steps, so it renders the cover and materials only and says so, rather than opening
thousands of canvases.

`mod/.../build/Schematic.java` is the parser the builder bot will use in M4, and
`verifySchematic` runs that exact class — so a passing check means the bot can place the
file, not merely that some reader could.

**M2 (AI generation) — working end to end, in the browser.** Type a description in the
editor and the build appears in the 3D viewer. Model is `claude-sonnet-5`; the schema and
prompt are generated from the same registry the expander uses, so they cannot drift.

The server returns the **program**, not voxels, and the browser expands it. That one choice
means a generated build is not a special case anywhere downstream: it gets the same mesher,
the same layer clip, and — the part worth seeing — its own live param sliders, so an
AI-generated tower can be resized exactly like a built-in sample. Generated builds are kept
in `sessionStorage`, because losing something you paid for to an accidental refresh is worse
than the code it takes to persist it.

```bash
node tools/generate.mjs "a small fishing hut on stilts"        # DRY RUN — costs nothing
node tools/generate.mjs "a small fishing hut on stilts" --go   # actually generates
node tools/generate.mjs --spend                                # ledger
```

API: `POST /api/generations/estimate` (free), `POST /api/generations` → `{id}`,
`GET /api/generations/:id/events` (SSE), `GET /api/spend`.

Browser-level checks, both driven over CDP:

```bash
node tools/verify-ui.mjs out/stone-watchtower.program.json shot.png   # free
node tools/drive-generate.mjs "a round stone watchtower" shot.png     # costs one generation
```

### Cost control

The API key on this project holds a small fixed balance meant to last a month, so spend
discipline is structural rather than advisory:

- **Dry run by default.** `tools/generate.mjs` without `--go` uses `count_tokens` (a free
  endpoint) to report exactly what a call would cost.
- **Budget ceiling.** `ANTHROPIC_MONTHLY_BUDGET_USD` in `apps/server/.env`. The guard runs
  *before* each request and sizes it at `max_tokens`, i.e. what the call *could* cost.
  Spend is recorded per call in `.spend/ledger.json` and survives restarts.
- **Prompt caching.** The system prompt and the tool schema are ~9.7k tokens and identical
  every call, so they bill at ~10% after the first — the single biggest lever here.
- **One repair round, ever.** A retry loop is how a small balance disappears.
- **Never discard a paid response.** Every emitted program is written to `out/` *before*
  validation, because if expansion fails that file is the only evidence and asking again
  costs real money.

Roughly $0.05–0.12 per build on Sonnet 5, so ~$4 buys 30–60 builds.

**M5 (accounts and the build library) — done.** Email plus password, argon2id, sessions in an
`HttpOnly; SameSite=Lax` cookie of which only the SHA-256 is stored — the same treatment agent
tokens already got. `/library` lists your saved builds; open one back into the editor, rename
it, delete it. A build is saved with both its voxels and its program, and reopened from the
program when one still describes it, so the resize sliders survive a round trip through the
database.

```bash
node tools/verify-auth.mjs                                  # API: sessions, ownership, expiry
node tools/verify-library.mjs out/verify-library.png        # the UI, over CDP
```

**Where the line is drawn, and why.** Anonymous use covers everything that runs in the browser:
the samples, the editing tools, both downloads and the printable guide. An account is required
for anything that owns server state, spends money, or can reach a Minecraft world — the
library, pairing, jobs, and generation.

That is not caution for its own sake. An earlier draft let signed-out callers act in an
"anonymous scope" that owned the rows with a null `user_id`, which reads reasonably until you
notice that *every* signed-out visitor resolves to the same scope: one person pairs their world,
and the next stranger to open the site finds it in their list and can send a bot into their
game. The same argument applies to generation — an anonymous caller has no identity to meter,
so the per-user quota does not exist for them and one loop empties the month's balance.

Ownership is therefore in the SQL rather than in a check a route might forget:
`WHERE ... AND user_id = $n`, so somebody else's build is not *found and rejected*, it is not
found. That is why touching another account's build or world is a 404 and never a 403 — a 403
confirms the id names something real.

The one place a session must **not** appear is the mod. `POST /api/agent/claim` and the
schematic fetch authenticate with an agent token and no cookie, because the caller is a
Minecraft server. `verify-agent.mjs` asserts both directions: the mod's token works with no
cookie, and a session cookie is not accepted in its place.

Quota is per user per rolling 24 hours (`users.daily_gen_quota`, default 30) and rows land in
`generations`. It is *fairness*, not the money stop — `SpendLedger` is still the hard ceiling
and still runs first. A server that cannot enforce the quota refuses to generate rather than
running unmetered.

**M6 (the dashboard) — done.** `/dashboard` is home for anyone with an account, and the
sign-in door for anyone without. It exists because the product is four things joined end to
end — generate, edit, export, build in game — and every one of them lived on its own route, so
the whole path was only visible to somebody who had already walked it.

What is on it: a prompt box that hands its text to the editor as `?prompt=` (it never spends a
generation itself — the editor shows the price first), four stat tiles, a three-step setup
checklist that hides itself once finished, the most recent builds, the paired worlds with the
pairing code, and the three ways a build leaves here.

Nothing on it is a second implementation. Builds come from the same `listBuilds` the library
uses, worlds from the same `useAgents` the editor's send panel uses, and the account form is
the library's `AccountPanel`. A dashboard is a *view* over the product; the moment it grows its
own copy of a feature, the two start disagreeing.

`shell/AppNav` is the other half. Before it, each route knew about one or two of its
neighbours by hand — the editor linked to `/mod` and `/status`, the library to the editor, the
mod page back to the editor — and which links you got depended on which door you came in
through. One component now owns the destinations, and the library and mod pages wear it in
place of the single back-link they each used to carry. Not the editor or the guide: the editor
is a full-viewport canvas with its own floating HUD, and the guide is a document that gets
printed. Both link back instead.

No new colour was introduced for any of it. What `styles.css` did grow is the vocabulary that
was missing: `--sunken` and `--raised` name two surfaces that were already in the product as
literals repeated across four stylesheets, and `--space-*`, `--radius-*` and `--text-*` are
closed scales — the same idea `guide/tokens.css` applies to the printed booklet, where a size
that is not on the scale is a bug rather than a decision. That is what makes a page assembled
from eight independent cards read as one surface.

The checklist's conditions are unit-tested (`dashboard/onboarding.test.ts`) rather than
eyeballed, because every step's tick is a claim about the account that has to be *observable*
from data already on the page. "Save your first build" keys off the library count and not
`generationsUsedToday`, which is a rolling 24-hour number — a step keyed off that would tick on
Monday and silently un-tick on Tuesday. Sending a build into a world is deliberately absent as
a finale: no endpoint reports whether a job ever ran, and inferring it from "a world has been
online" would tick for somebody who paired and then closed the game.

### Verifying changes

Tests prove blocks land where asserted; they do not prove the result reads as a building.
After any geometry change, look at it:

```bash
node tools/inspect.mjs cottage --slice x 10   # gable cross-section
node tools/inspect.mjs cottage --slice z 11   # south elevation
node tools/inspect.mjs pavilion 4             # every 4th layer, top-down
```

Screenshot the running viewer (waits for meshing to finish — `--virtual-time-budget` alone
captures an empty scene, because the mesher runs on a worker thread):

```bash
node tools/shot.mjs "http://localhost:3016/?build=cottage" shot.png
```

Prove a generated `.schem` is readable by Minecraft itself, and that every palette entry
resolves to a real `BlockState` — neither the TypeScript round-trip nor the `prismarine-nbt`
test covers that:

```bash
cd mod && JAVA_HOME="C:/Users/tobia/tools/jdk25" ./gradlew verifySchematic -Pschem=../out/oak-cottage.schem
```

## Deployment

**It is one service.** The Fastify process in `apps/server` serves the built frontend as
static files *and* hosts the API *and* the agent WebSocket gateway. There is no separate
backend for the mod: `craftmagic.online` serves the site, and the mod dials
`wss://craftmagic.online/agent/ws` — the same origin, the same container, one port.

```
                    ┌──────────────────────────────────────────┐
  browser  ────────►│  craftmagic.online   (one container)     │
                    │                                          │
  Minecraft ───────►│  Fastify ─┬─ static  apps/web/dist       │
  (the mod, dialling│           ├─ /api/*  REST + SSE          │──► Postgres
   out over wss://) │           └─ /agent/ws  WebSocket hub    │──► Anthropic
                    └──────────────────────────────────────────┘
```

The mod always dials *out*. Nothing connects inbound to a player's machine, which is what
makes this work behind home routers with no port forwarding.

### Production: ServerHoster

Production is a ServerHoster service built from this repo. ServerHoster clones the repo and
builds the `Dockerfile`, so a deploy is a push plus a rebuild in its UI.

Set these in the service's environment:

| Variable | Value | Why |
|---|---|---|
| `DATABASE_URL` | `postgres://…` | From a ServerHoster Postgres resource. Without it, pairing and the library are disabled but the site still runs. |
| `SESSION_SECRET` | 32+ random bytes | Set once. Changing it signs everyone out. |
| `PUBLIC_ORIGIN` | `https://craftmagic.online` | Must match what the mod dials — it is baked into the pairing and schematic URLs handed to the mod. |
| `ANTHROPIC_API_KEY` | `sk-ant-…` | Omit to run with generation disabled (`503`) and everything else working. |
| `ANTHROPIC_MONTHLY_BUDGET_USD` | e.g. `1.5` | Hard pre-call ceiling. **Per instance** — see the warning below. |
| `PORT` | `3016` | Optional; the image defaults to this and ServerHoster maps it. |

Two things that are easy to get wrong:

- **`PUBLIC_ORIGIN` and the mod's `serverUrl` are one setting in two places.** The jar has
  `https://craftmagic.online` compiled in as its default. If the site's origin changes, the
  mod must be rebuilt and re-published or already-installed copies keep dialling the old
  address. `/craftmagic server <url>` is the per-world escape hatch.
- **The spend ledger is per instance, not per API key.** Each deployment keeps its own
  `.spend/ledger.json` and enforces its own ceiling, so running two instances on one key
  doubles the real ceiling. Budget the sum, not each one.

### Staging: the systemd service

`tools/deploy.mjs` is the older path and still works — it deploys to `85.190.100.23:3016` as a
systemd unit with its own Postgres in Docker. Useful as staging, but **do not run it against
the same database as production**, and stop it once ServerHoster owns the domain, or two
instances will answer for the same product with separate ledgers.

```bash
node tools/deploy.mjs              # build, ship, restart, health-check
node tools/verify-deployed.mjs     # check a live instance (free — makes no Anthropic call)
```

It builds locally and ships only `dist` output plus the lockfile. That split is deliberate:
`tsc` and `vite` emit platform-independent JavaScript, but `argon2` is a native module whose
Windows binary is useless on Linux, so dependencies are installed on the far side with
`npm ci --omit=dev`.

| Piece | Where | Notes |
|---|---|---|
| App | `/opt/craftmagic`, service `craftmagic` | runs as the `craftmagic` system user |
| Database | Docker `craftmagic-db`, `127.0.0.1:54328` | Postgres 17, bound to loopback |
| Secrets | `/opt/craftmagic/.env`, mode 600 | written once, never overwritten by a redeploy |
| Logs | `journalctl -u craftmagic -f` | |

That database listens on loopback rather than `0.0.0.0` because the host's firewall script only
covers ports someone remembered to add to its `PORTS=` list, and a port that never faces the
internet cannot be left off that list by accident. The app's own port *must* stay open — the
mod dials in from the player's own machine.

`.env` is written on first deploy and then left alone, so a redeploy cannot rotate
`SESSION_SECRET` (which would log everyone out) or invalidate paired worlds.

### The API key, and what actually protects the balance

`ANTHROPIC_API_KEY` is installed in the deployed `.env`, so generation is live. It was
deliberately withheld until accounts were enforced: port 3016 is reachable by anyone who scans
it, and an open `/api/generations` with a key behind it is a stranger spending the month's
balance. The order mattered — the key went in only once anonymous callers got a `401`.

Three independent limits stand between a visitor and the balance, and they fail in that order:

1. **Authentication.** `/api/generations` and `/api/generations/estimate` require a session.
   `tools/verify-deployed.mjs` asserts an anonymous POST gets `401`, not a generation.
2. **Per-user daily quota.** Fairness between accounts, not a spend limit — registration is
   open, so someone determined can make more accounts.
3. **The ledger ceiling** (`ANTHROPIC_MONTHLY_BUDGET_USD`). This is the real backstop, because
   it does not care who is asking. The check runs *before* the request and is sized at
   `max_tokens`, i.e. what the call could cost rather than what it probably will.

The deploy script never carries the key — `tools/deploy/install-key.sh` is a separate one-off,
so a redeploy can't rotate or clobber a working secret. It reads the key from a file rather
than argv (argv is readable through `/proc`), refuses anything not shaped like an Anthropic
key, and restores its backup if the result looks wrong.

To confirm the key works without being billed, `POST /api/generations/estimate` reaches
Anthropic via `count_tokens`, which is free:

```bash
curl -s -X POST http://85.190.100.23:3016/api/generations/estimate \
  -H 'Content-Type: application/json' -b "cm_session=$TOKEN" \
  -d '{"prompt":"a small stone cottage"}'
```

One caveat about the systemd sandbox: the unit runs `ProtectSystem=strict`, and the spend
ledger is the only thing the service writes. If `ReadWritePaths` ever stops covering
`.spend/`, generation will bill Anthropic and *then* fail to record it — the worst possible
place to lose a write. That path is verified inside the real sandbox, not just checked for
file permissions:

```bash
sudo systemd-run --pipe --uid=craftmagic --property=ProtectSystem=strict \
  --property=ReadWritePaths=/opt/craftmagic/.spend \
  /bin/sh -c 'echo probe > /opt/craftmagic/.spend/_probe && rm -f /opt/craftmagic/.spend/_probe'
```

### The mod

`tools/bundle-mod.mjs` copies `mod/build/libs/*.jar` into `apps/web/dist/mod/` so the site can
serve it at `/mod/craftmagic-mod.jar`. It runs *after* the web build, because vite empties
`dist` on every run. The jar's default `serverUrl` is the deployment address and has to stay in
step with `PUBLIC_ORIGIN`; when a domain is registered, both change together.

See `.claude/plans/` for the full milestone plan.
