# CraftMagic Studio rebuild

## Product contract

One workspace for a creator to open a structure, draw its plan, edit its blocks, compose a world, and deliver the result. Preserve existing document formats, authentication, generation, exports and agent APIs. Do not turn document tabs into copies, hide unsaved work behind a reassuring status, or confuse a local draft with account storage.

## Baseline audit

- Three independently positioned full-screen editors, floating HUDs and stacked scrolling panels compete for the same space.
- The shared header repeats navigation and file actions but has no persistent document tabs or coherent panel layout.
- AI takes the default inspector space even during manual work. Materials, geometry and output are buried in the same scrolling columns.
- Commands know navigation but not current editing tools; modal keyboard focus can escape behind the dialog.
- Project undo has no visible timeline and the shell routes old architecture/world frames to whichever document was last open.
- File browser uses browser prompt/confirm, exposes no sort/filter workflow and swallows loading failures.
- Baseline build and tests pass. A redesign must preserve those capabilities, not replace them with decorative buttons.

## Implementation and acceptance

- Dedicated studio shell; no application navigation inside the canvas. Document tabs, canonical identities, bounded recent work and recoverable layouts.
- Resizable, collapsible docks with task tabs. Panels render through explicit React portals; edit state remains with the owning editor.
- Shared command registry with active tool commands, ranked search, keyboard navigation and focus restoration.
- Visible project history and exact document routes for cross-document undo.
- Inline file operations, explicit loading/error/retry states and accessible modal primitives.
- Responsive canvas/tools/inspector views, focus mode, reduced motion and consistent controls.
- Preserve old URLs, saved section preferences and existing local drafts. No database migration or generator protocol change.
- Test pure workspace models, interaction failures, navigation, repeated edits, interrupted dialogs, exports, persistence and responsive layouts in a real browser.

Line count is reported honestly. Generated repetition, vendored files and formatting churn are not substitutes for working product improvements.

## What changed

### Canvas-first workbench

The studio now owns window layout. Each editor renders into a bounded center stage, and its existing controls are moved into task docks through React portals. Resizing a dock does not remount the engine or re-create its editing session. Perspective and orthographic framing compensate for viewport resizing without resetting the user's orbit target.

- Document strip with open, close, pin, reorder and recent-document navigation
- Separate World / Plan / Build levels, preserving canonical links and legacy redirects
- Resizable tool and inspector docks, keyboard-accessible separators, per-mode panel preferences
- Focus mode (F8), compact/comfortable density, and narrow-screen Canvas / Tools / Inspector views
- A consistent New document wizard for named structures, floorplans/templates and worlds
- Explicit account-versus-device storage labels and unsaved state
- Editor error containment, leaving navigation and saved-file recovery available

### Editing workflows

- Build tools, shape controls and asset/material discovery no longer share one endless panel
- Block library with category filtering, search, favourites and bounded result rendering
- Searchable component outliner, visibility filters, isolate/show-all and camera framing
- Plan storeys and building properties on the left; selection, room schedule and checks on the right
- World terrain tools and component shelf on the left; placement inspection and map/region settings on the right
- AI remains accessible in its own dock; the generator, provider selection, prompts and server generation pipeline are unchanged
- Deliver reveals the real save/export/game-delivery controls, not a second implementation of export formats

### Document reliability

Plan and world undo stacks are keyed by the actual document route. A bounded in-memory working-copy cache lets a mode switch recover the matching document before applying a pending undo. Replacing a document invalidates only that document's journal entries. Renaming or deleting a saved document invalidates its cached copy so a stale unmount cannot resurrect it.

History is session memory, not an infinite durable version archive. Existing named saves, browser autosaves and account storage remain authoritative. The UI continues to warn before opening a different document with unsaved changes. Working-copy caches are capped (plans: 16 entries/16 MiB; worlds: 12 entries/64 MiB).

Floorplan history mutations now happen outside React state-updater callbacks. React StrictMode may replay those callbacks, so side effects there could record the same edit twice. No-op commits no longer mark a plan dirty.

IndexedDB writes now report success only after the transaction commits. Missing/blocked storage returns failure. Named floorplan saves also propagate localStorage failure rather than marking the document clean. The header exposes in-progress saves and errors; file-manager mutations are guarded against duplicate submission.

### Finding and managing work

The file manager has type/storage filters, search, sorting, grid/list layouts, selection details, inline rename and explicit delete confirmation. Cancel does not submit changes. List failures are visible and retryable. The command palette uses ranked multiword search, recent actions, editor tool/view commands and a contained keyboard workflow.

## Verification commands

```sh
npm ci
npm run build
npm test
npm run test:database
npx playwright install chromium
npm run test:browser
```

`test:database` starts an ephemeral, loopback-only PostgreSQL-WASM instance through PGlite's protocol adapter, enables citext, runs the existing server suites serially, and shuts it down. It does not connect to a production database. This extends local coverage; it does not replace testing against the deployment's PostgreSQL version.

To run browser account flows against a disposable database on POSIX:

```sh
CM_USE_TEST_DATABASE=1 node tools/test-database.mjs node tools/verify-workspace.mjs
```

Set `BROWSER_EXECUTABLE` to an installed Chromium path if required. `CM_SHOTS` selects an evidence directory. The browser suite starts its own isolated server, blocks external browser requests, disables model-generation submissions and uses fixture accounts only. Screenshots and downloads are written under `test-artifacts/` by default and are not committed.

## Review boundaries

No production deployment, Minecraft-server connection, paid model request or existing user account modification is part of this change. Automated accessibility checks supplement keyboard/pointer and visual inspection; they are not a claim of complete accessibility certification. The Fabric mod, build-program schema and AI generation pipeline are preserved.

### Runtime and recovery fixes found during verification

- First-time account world saves now create a row directly for browser-generated IDs. Sending a local `world_…` ID to a PostgreSQL UUID update route previously produced a 500 instead of creating the world.
- The file manager includes device maps alongside account maps after sign-in, and rename/delete uses the selected file's storage adapter.
- Missing or offline world/floorplan documents have explicit loading/error states. A temporary blank world cannot be saved under the failed document's identity.
- Cancelling browser Back restores the router as well as the URL, preserving the edited document.
- The runtime dependency audit found four high-severity entries in the inherited server graph. Fastify and its static plugin are updated to patched releases, with patched URI/brace dependencies. The production-only npm audit reports zero findings after the update. Generation logic and provider configuration were not changed.

## Verification result for this implementation

- Core: 482 tests passed.
- Web/editor: 475 tests passed.
- Server: 188 tests passed with the isolated PostgreSQL-WASM database (including the 61 database-dependent tests skipped by an unconfigured baseline run).
- Browser: 45 workflow scenarios passed, including signed-in saves and file operations, linked plans, cross-document undo/redo, manual voxel edits, world creation, error recovery, cancelled browser Back, four viewport widths and automated WCAG A/AA checks across all three editors and every dock panel.
- Production build, TypeScript, focused changed-code lint, clean installation/build and production dependency audit passed. Vite still reports the expected large Three.js bundle warning; this is not a zero-warning bundler claim.

All application changes were implemented directly for this request. No coding task was delegated. The PR is for review; merging and deployment are separate actions.
