/**
 * Builds, agents and jobs.
 *
 *   POST   /api/builds                     save a build (send-to-game transport, or library)
 *   GET    /api/builds                     the caller's library
 *   GET    /api/builds/:id                 one build, voxels included
 *   PATCH  /api/builds/:id                 rename
 *   DELETE /api/builds/:id                 delete
 *   POST   /api/worlds                     save a world (its description, never its voxels)
 *   GET    /api/worlds                     the caller's worlds, without their heightfields
 *   GET    /api/worlds/:id                 one world, heightfield included
 *   PATCH  /api/worlds/:id                 rename, save over, or both
 *   DELETE /api/worlds/:id                 delete
 *   POST   /api/agent/pair-codes           mint a 6-character code for the player to type
 *   POST   /api/agent/claim                the mod exchanges that code for a token
 *   GET    /api/agent/agents               paired worlds, with online status
 *   POST   /api/agent/jobs                 send a build to a world
 *   GET    /api/agent/jobs/:id/events      SSE progress for the website
 *   GET    /api/agent/jobs/:id/schem       the mod fetches the build (agent token required)
 *
 * There are two authentication schemes here and they must not be confused. Everything the
 * *website* calls needs a session cookie — see the ownership policy in `auth/routes.ts`.
 * Everything the *mod* calls carries an agent token in an `Authorization` header and no
 * cookie at all, because it is a Minecraft server rather than a browser. `/claim` has neither,
 * and deliberately so: the mod has no credential yet, and the short-lived single-use code the
 * player reads off their own screen is what makes "the website can build in my world" safe.
 *
 * Every browser-facing route in this file requires an account. That is not squeamishness
 * about anonymous users — it is that an anonymous session has no identity to scope by, so
 * every signed-out visitor to a public deployment would resolve to the same scope and share
 * one pool of paired worlds. A stranger would open the site, see somebody's Minecraft world
 * in the list, and be able to send a bot into it. Requiring an account is what makes "your
 * worlds" mean anything at all.
 */

import {
	decodeVoxels,
	fromBase64,
	schematicFilename,
	toBase64,
	writeSchematic,
	WORLD_LIMITS,
	WORLD_VERSION,
	type VoxelGrid,
	type JobRegion,
} from '@craftmagic/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Auth } from '../auth/session.js';
import type { AgentHub } from './hub.js';
import type { AgentStore, BuildKind, WorldDocument, WorldRow } from './store.js';

export interface AgentRoutesOptions {
	store: AgentStore | null;
	hub: AgentHub | null;
	auth: Auth;
	publicOrigin: string;
}

const MAX_BUILD_NAME = 80;

/**
 * The tiers a saved build can be filed under, and the only two accepted on the wire.
 *
 * There is no `world` here and there is not going to be one. A world places saved builds; it
 * has no voxels of its own, and `builds.voxels` is NOT NULL, so a world is not a build with a
 * different label on it — it is a different table, and `/api/worlds` below is the door to it.
 * Reaching for a third value here is the symptom, not the fix.
 */
const BUILD_KINDS = ['structure', 'interior'] as const;

/**
 * The region metadata on a job, or `null` for a lone build.
 *
 * `'bad'` rather than `null` for a malformed one, because the two mean opposite things: no
 * region is an ordinary send and has to keep working, while a region that arrived mangled
 * would place a piece of somebody's map at the wrong coordinates and look deliberate.
 */
export function readRegion(raw: unknown): JobRegion | null | 'bad' {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== 'object') return 'bad';
	const r = raw as Record<string, unknown>;
	const offset = r.offset as Record<string, unknown> | undefined;
	const int = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) ? value : null);

	const worldId = typeof r.worldId === 'string' && r.worldId.length > 0 ? r.worldId : null;
	const index = int(r.index);
	const total = int(r.total);
	const rx = int(r.rx);
	const rz = int(r.rz);
	const x = int(offset?.x);
	const y = int(offset?.y);
	const z = int(offset?.z);
	if (worldId === null || index === null || total === null || rx === null || rz === null) return 'bad';
	if (x === null || y === null || z === null) return 'bad';
	if (index < 0 || total < 1 || index >= total) return 'bad';

	return { worldId, index, total, rx, rz, offset: { x, y, z } };
}

export function agentRoutes(options: AgentRoutesOptions): FastifyPluginAsync {
	return async (app) => {
		const { store, hub, auth } = options;

		/** Every route here needs the database; without it the feature is simply off. */
		function requireDb(reply: { code: (n: number) => { send: (b: unknown) => unknown } }): boolean {
			if (store && hub) return true;
			reply.code(503).send({ error: 'no_database', message: 'this server has no database configured' });
			return false;
		}

		function bearer(request: FastifyRequest): string | null {
			const header = request.headers.authorization ?? '';
			return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
		}

		function readName(value: unknown): string {
			return typeof value === 'string' ? value.trim().slice(0, MAX_BUILD_NAME) : '';
		}

		/**
		 * The build's tier: a valid one, `'structure'` when the field is absent, or `null` for
		 * anything else — which the caller turns into a 400.
		 *
		 * Absent and wrong are not the same thing, and that distinction is the whole point of
		 * this function. Absent is an older client that predates the field, and defaulting it
		 * to `'structure'` is right. Wrong is a typo, a stale enum, or a client sending a tier
		 * this server has never heard of, and coercing *that* to `'structure'` files the build
		 * in the wrong drawer permanently: the save answers 201, the row looks healthy, and the
		 * only symptom is an interior that turns up in the component shelf months later with
		 * nothing left to say where it came from. A 400 costs one failed request and is fixed
		 * before it ships.
		 *
		 * `null` rather than a thrown error so the check reads like the `readName` above it.
		 */
		function readKind(value: unknown): BuildKind | null {
			if (value === undefined || value === null) return 'structure';
			return BUILD_KINDS.includes(value as BuildKind) ? (value as BuildKind) : null;
		}

		// --- builds — all session-authenticated ------------------------------

		/**
		 * Big enough for the largest build the engine will produce, and no bigger.
		 *
		 * A 256x160x256 build of pure noise encodes to ~2.8 MB of ICVX, ~3.8 MB in base64; a
		 * realistic one of that size is under 300 KB. 16 MB is several times the pathological
		 * case and a small fraction of what the JSON array it replaces would have needed.
		 */
		const BUILD_BODY_LIMIT = 16 * 1024 * 1024;

		/**
		 * Below this, a build is also sent in the old `voxels` array form.
		 *
		 * Purely a rollout courtesy for a browser tab still running the previous deploy. 200k
		 * cells is ~400 KB of JSON — every build anyone had actually managed to save before
		 * this change, since the 1 MB body limit capped saving at roughly 80 cubed.
		 */
		const LEGACY_VOXEL_CELLS = 200_000;

		app.post('/api/builds', { bodyLimit: BUILD_BODY_LIMIT }, async (request, reply) => {
			if (!requireDb(reply)) return;
			// Saving used to be open, because "send to game" needed it and there was nothing
			// else it could do. Sending now requires an account, so an anonymous save would
			// write a row nobody — including its author — could ever reach again: unreachable
			// state, and an unauthenticated way to push megabytes of voxels into the database.
			const user = await auth.requireUser(request, reply);
			if (!user) return;

			const body = request.body as {
				name?: unknown;
				description?: unknown;
				program?: unknown;
				detached?: unknown;
				edits?: unknown;
				plan?: unknown;
				kind?: unknown;
				library?: unknown;
				grid?: {
					size?: { x: number; y: number; z: number };
					palette?: string[];
					/** The compact form: base64 of the gzipped ICVX blob. Preferred. */
					data?: unknown;
					/** The old form, one JSON number per cell. Kept for a release; see below. */
					voxels?: number[];
				};
			} | null;

			const name = readName(body?.name);
			if (!name) return reply.code(400).send({ error: 'bad_name' });

			// Checked here, before the voxels are decoded: a rejection should not first cost
			// the server a 16 MB gunzip it is going to throw away.
			const kind = readKind(body?.kind);
			if (!kind) {
				return reply
					.code(400)
					.send({ error: 'bad_kind', message: `kind must be one of ${BUILD_KINDS.join(', ')}` });
			}

			const grid = body?.grid;
			if (!grid?.size) return reply.code(400).send({ error: 'bad_grid' });

			const expected = grid.size.x * grid.size.y * grid.size.z;
			const { decodeVoxels, encodeVoxels, fromBase64 } = await import('@craftmagic/core');

			/**
			 * Two accepted shapes, and the reason there are two.
			 *
			 * `data` is the ICVX blob this column already stores, base64'd — a 256x160x256 build
			 * is ~280 KB that way and 20 MB as a JSON array of integers, which is 20x over
			 * Fastify's body limit. Until this existed, a build at the engine's own documented
			 * size cap could not be saved at all, and neither could the "Stress test" sample
			 * shipped in the editor: both answered 413.
			 *
			 * `voxels` is the old shape. Kept for one release so a tab loaded from the previous
			 * deploy keeps working, and because it costs eight lines to keep.
			 */
			let voxelGrid: VoxelGrid;
			if (typeof grid.data === 'string') {
				try {
					voxelGrid = decodeVoxels(fromBase64(grid.data));
				} catch {
					return reply.code(400).send({ error: 'bad_grid', message: 'voxel data did not decode' });
				}
				// The blob is self-describing, so it can disagree with the size that came beside
				// it. Trust neither: say so rather than storing a row whose header lies.
				const decoded = voxelGrid.size;
				if (decoded.x !== grid.size.x || decoded.y !== grid.size.y || decoded.z !== grid.size.z) {
					return reply.code(400).send({ error: 'bad_grid', message: 'voxel data size does not match' });
				}
			} else if (Array.isArray(grid.palette) && Array.isArray(grid.voxels)) {
				if (grid.voxels.length !== expected) {
					return reply.code(400).send({ error: 'bad_grid', message: `expected ${expected} voxels` });
				}
				voxelGrid = { size: grid.size, palette: grid.palette, voxels: Uint16Array.from(grid.voxels) };
			} else {
				return reply.code(400).send({ error: 'bad_grid' });
			}

			let blockCount = 0;
			for (const v of voxelGrid.voxels) if (v !== 0) blockCount++;
			const id = await store!.saveBuild({
				name,
				description: typeof body?.description === 'string' ? body.description : null,
				sizeX: grid.size.x,
				sizeY: grid.size.y,
				sizeZ: grid.size.z,
				blockCount,
				voxels: encodeVoxels(voxelGrid),
				program: body?.program,
				userId: user.id,
				detached: body?.detached === true,
				// Shape-checked no further than "an object": the layer is the client's format,
				// the server only ferries it, and the client-side reader already survives junk.
				edits: typeof body?.edits === 'object' ? body.edits : null,
				// Same deal: Architecture mode's `normalizePlan` re-validates everything on read.
				plan: typeof body?.plan === 'object' ? body.plan : null,
				// Unlike `edits` and `plan`, this one is validated rather than ferried: it is
				// the server's own vocabulary, and the column has a CHECK that would turn a
				// junk value into a 500 at the very end of a multi-megabyte upload.
				kind,
				// The transport row "send to game" writes stays out of the library; only an
				// explicit save belongs in a list the user curates.
				inLibrary: body?.library === true,
			});

			return reply.code(201).send({ id, blockCount });
		});

		app.get('/api/builds', async (request, reply) => {
			if (!requireDb(reply)) return;
			const user = await auth.requireUser(request, reply);
			if (!user) return;
			return { builds: await store!.listBuilds(user.id) };
		});

		/**
		 * One build, voxels and all.
		 *
		 * `program` comes back beside the voxels rather than instead of them because the two
		 * answer different questions: the program re-expands at any size and keeps the param
		 * sliders working, but once a build has been hand-edited (`detached`) no program
		 * describes what is on screen, and only the voxels do. The client decides; the server
		 * hands over both and says which case it is.
		 */
		app.get<{ Params: { id: string } }>('/api/builds/:id', async (request, reply) => {
			if (!requireDb(reply)) return;
			const user = await auth.requireUser(request, reply);
			if (!user) return;

			const build = await store!.getBuild(request.params.id, user.id);
			if (!build) return reply.code(404).send({ error: 'unknown_build' });

			const grid = decodeVoxels(new Uint8Array(build.voxels));

			/**
			 * The blob goes back out as base64, not as a JSON array of integers.
			 *
			 * `Array.from(grid.voxels)` on a 256x160x256 build is a 20 MB response — 10.5 million
			 * numbers to serialise here and parse in the browser — for data the column already
			 * holds in ~280 KB. The client reads `data` when it is there and falls back to
			 * `voxels`, so a tab loaded from the previous deploy keeps working through the
			 * rollout; `voxels` is only sent when it is small enough to be worth the bytes.
			 */
			const compact = toBase64(new Uint8Array(build.voxels));
			const small = grid.voxels.length <= LEGACY_VOXEL_CELLS;

			return {
				id: build.id,
				name: build.name,
				size: grid.size,
				blockCount: build.blockCount,
				kind: build.kind,
				detached: build.detached,
				program: build.program,
				edits: build.edits,
				plan: build.plan,
				grid: {
					size: grid.size,
					palette: grid.palette,
					data: compact,
					...(small ? { voxels: Array.from(grid.voxels) } : {}),
				},
			};
		});

		app.patch<{ Params: { id: string } }>('/api/builds/:id', async (request, reply) => {
			if (!requireDb(reply)) return;
			const user = await auth.requireUser(request, reply);
			if (!user) return;

			const name = readName((request.body as { name?: unknown } | null)?.name);
			if (!name) return reply.code(400).send({ error: 'bad_name' });

			const renamed = await store!.renameBuild(request.params.id, user.id, name);
			if (!renamed) return reply.code(404).send({ error: 'unknown_build' });
			return { id: request.params.id, name };
		});

		app.delete<{ Params: { id: string } }>('/api/builds/:id', async (request, reply) => {
			if (!requireDb(reply)) return;
			const user = await auth.requireUser(request, reply);
			if (!user) return;

			const deleted = await store!.deleteBuild(request.params.id, user.id);
			if (!deleted) return reply.code(404).send({ error: 'unknown_build' });
			return { ok: true };
		});

		// --- worlds — all session-authenticated ------------------------------

		/**
		 * Room for the biggest world `WORLD_LIMITS` allows, and not much more.
		 *
		 * 2048² is 4.2 million columns: 8.4 MB of Int16 heights and 4.2 MB of strata bytes,
		 * which base64 to 16.8 MB before the document is counted. Fastify's default is 1 MiB,
		 * and a default left in place here would 413 every world bigger than about 380 columns
		 * square — silently, in the sense that the save looks like a network failure rather
		 * than like a limit. `/api/builds` shipped exactly that bug.
		 */
		const WORLD_BODY_LIMIT = 32 * 1024 * 1024;

		/**
		 * The cap on the json half — the strata palette, the overlay and the placements.
		 *
		 * The counts below bound how many of each there may be, but not how big one is: an
		 * overlay chunk carries a base64 string of arbitrary length, so 100,000 legal chunks
		 * can still be any number of megabytes. This is the bound that actually holds.
		 */
		const WORLD_DOC_LIMIT = 8 * 1024 * 1024;

		/** A rejection, in the shape the reply takes. */
		interface WorldReject {
			error: string;
			message: string;
		}

		interface ParsedWorld {
			sizeX: number;
			sizeZ: number;
			minY: number;
			maxY: number;
			seaLevel: number;
			regionSize: number;
			heights: Uint8Array;
			strata: Uint8Array;
			doc: WorldDocument;
		}

		function rejected(value: ParsedWorld | WorldReject): value is WorldReject {
			return 'error' in value;
		}

		/** An integer, or null for anything that is not one. Fractions are not rounded in. */
		function whole(value: unknown): number | null {
			return typeof value === 'number' && Number.isInteger(value) ? value : null;
		}

		function within(value: unknown, min: number, max: number): number | null {
			const n = whole(value);
			return n !== null && n >= min && n <= max ? n : null;
		}

		/**
		 * Read a world off the wire, or say precisely why it is not one.
		 *
		 * The client sends `worldToJSON(doc)` verbatim, so this reads the same fields
		 * `normalizeWorld` will read them back out of, and the two typed arrays arrive as the
		 * base64 `EncodedTerrain` that codec already produces.
		 *
		 * Nothing here is clamped, and that is the difference between this and
		 * `normalizeWorld`. The client normalises because it is opening a document it must not
		 * refuse to show; the server refuses because it is writing a row that has to still be
		 * readable in a year. A heights blob two bytes short of its stated extent is not a
		 * world with a small mistake in it — every column past the gap decodes at the wrong
		 * index, so the map comes back sheared, and sheared terrain still looks like terrain.
		 * Clamping that into a stored row is how the corruption becomes permanent.
		 */
		function readWorld(body: unknown): ParsedWorld | WorldReject {
			const raw = (body ?? {}) as {
				settings?: {
					size?: { x?: unknown; z?: unknown };
					minY?: unknown;
					maxY?: unknown;
					seaLevel?: unknown;
					regionSize?: unknown;
					strata?: unknown;
				};
				terrain?: { x?: unknown; z?: unknown; height?: unknown; strata?: unknown };
				overlay?: unknown;
				placements?: unknown;
			};

			const settings = raw.settings;
			if (typeof settings !== 'object' || settings === null) {
				return { error: 'bad_settings', message: 'settings is required' };
			}

			const sizeX = within(settings.size?.x, WORLD_LIMITS.minSize, WORLD_LIMITS.maxSize);
			const sizeZ = within(settings.size?.z, WORLD_LIMITS.minSize, WORLD_LIMITS.maxSize);
			if (sizeX === null || sizeZ === null) {
				return {
					error: 'bad_size',
					message: `size must be whole numbers between ${WORLD_LIMITS.minSize} and ${WORLD_LIMITS.maxSize}`,
				};
			}

			// Each bound is checked against the one before it, so the three arrive in order or
			// not at all: a sea level above the ceiling floods a world that has no room for it.
			const badBounds: WorldReject = {
				error: 'bad_bounds',
				message: `minY, maxY and seaLevel must sit inside ${WORLD_LIMITS.floorY}..${WORLD_LIMITS.ceilingY}, in that order`,
			};
			const minY = within(settings.minY, WORLD_LIMITS.floorY, WORLD_LIMITS.ceilingY - 1);
			if (minY === null) return badBounds;
			const maxY = within(settings.maxY, minY + 1, WORLD_LIMITS.ceilingY);
			if (maxY === null) return badBounds;
			const seaLevel = within(settings.seaLevel, minY, maxY);
			if (seaLevel === null) return badBounds;

			const regionSize = within(
				settings.regionSize,
				WORLD_LIMITS.minRegionSize,
				WORLD_LIMITS.maxRegionSize,
			);
			if (regionSize === null) {
				return {
					error: 'bad_region',
					message: `regionSize must be between ${WORLD_LIMITS.minRegionSize} and ${WORLD_LIMITS.maxRegionSize}`,
				};
			}

			const terrain = raw.terrain;
			if (
				typeof terrain !== 'object' ||
				terrain === null ||
				typeof terrain.height !== 'string' ||
				typeof terrain.strata !== 'string'
			) {
				return { error: 'bad_terrain', message: 'terrain.height and terrain.strata must be base64' };
			}

			// The stride travels with the arrays, so it can disagree with the extent beside it.
			// Trust neither: a world stored under one stride and read back at another is the
			// shear this whole function exists to keep out of the table.
			if (
				(terrain.x !== undefined && terrain.x !== sizeX) ||
				(terrain.z !== undefined && terrain.z !== sizeZ)
			) {
				return { error: 'bad_terrain', message: 'terrain stride does not match the world size' };
			}

			const columns = sizeX * sizeZ;
			const heights = fromBase64(terrain.height);
			if (heights.length !== columns * 2) {
				return {
					error: 'bad_terrain',
					message: `expected ${columns * 2} bytes of heights, got ${heights.length}`,
				};
			}

			const strata = fromBase64(terrain.strata);
			if (strata.length !== columns) {
				return {
					error: 'bad_terrain',
					message: `expected ${columns} bytes of strata, got ${strata.length}`,
				};
			}

			const palette = settings.strata;
			if (!Array.isArray(palette) || palette.length === 0 || palette.length > WORLD_LIMITS.maxStrata) {
				return {
					error: 'bad_document',
					message: `settings.strata must hold 1 to ${WORLD_LIMITS.maxStrata} profiles`,
				};
			}

			const overlay = raw.overlay ?? {};
			if (typeof overlay !== 'object' || overlay === null || Array.isArray(overlay)) {
				return { error: 'bad_document', message: 'overlay must be an object keyed by chunk' };
			}
			if (Object.keys(overlay).length > WORLD_LIMITS.maxOverlayChunks) {
				return {
					error: 'bad_document',
					message: `overlay is limited to ${WORLD_LIMITS.maxOverlayChunks} chunks`,
				};
			}

			const placements = raw.placements ?? [];
			if (!Array.isArray(placements) || placements.length > WORLD_LIMITS.maxPlacements) {
				return {
					error: 'bad_document',
					message: `placements must be an array of at most ${WORLD_LIMITS.maxPlacements}`,
				};
			}

			const document: WorldDocument = { strata: palette, overlay, placements };
			if (JSON.stringify(document).length > WORLD_DOC_LIMIT) {
				return { error: 'bad_document', message: 'world document is too large to store' };
			}

			return { sizeX, sizeZ, minY, maxY, seaLevel, regionSize, heights, strata, doc: document };
		}

		/**
		 * A stored world in the shape `normalizeWorld` reads.
		 *
		 * Assembled here rather than kept whole in the jsonb column because the extent and the
		 * bounds are the server's business — they are what the heights blob is measured
		 * against — so they are columns, and this is where the two halves are put back
		 * together. What comes out is `worldToJSON`'s own output, so the client round trip is
		 * `normalizeWorld(await response.json())` with nothing in between.
		 */
		function worldResponse(world: WorldRow) {
			return {
				version: WORLD_VERSION,
				id: world.id,
				name: world.name,
				settings: {
					size: { x: world.sizeX, z: world.sizeZ },
					minY: world.minY,
					maxY: world.maxY,
					seaLevel: world.seaLevel,
					regionSize: world.regionSize,
					strata: world.doc.strata,
				},
				terrain: {
					x: world.sizeX,
					z: world.sizeZ,
					height: toBase64(new Uint8Array(world.heights)),
					strata: toBase64(new Uint8Array(world.strata)),
				},
				overlay: world.doc.overlay,
				placements: world.doc.placements,
				createdAt: world.createdAt,
				updatedAt: world.updatedAt,
			};
		}

		app.post('/api/worlds', { bodyLimit: WORLD_BODY_LIMIT }, async (request, reply) => {
			if (!requireDb(reply)) return;
			const user = await auth.requireUser(request, reply);
			if (!user) return;

			const name = readName((request.body as { name?: unknown } | null)?.name);
			if (!name) return reply.code(400).send({ error: 'bad_name' });

			const parsed = readWorld(request.body);
			if (rejected(parsed)) return reply.code(400).send(parsed);

			const id = await store!.createWorld({ ...parsed, name, userId: user.id });
			return reply.code(201).send({ id, name });
		});

		app.get('/api/worlds', async (request, reply) => {
			if (!requireDb(reply)) return;
			const user = await auth.requireUser(request, reply);
			if (!user) return;
			return { worlds: await store!.listWorlds(user.id) };
		});

		app.get<{ Params: { id: string } }>('/api/worlds/:id', async (request, reply) => {
			if (!requireDb(reply)) return;
			const user = await auth.requireUser(request, reply);
			if (!user) return;

			const world = await store!.getWorld(request.params.id, user.id);
			if (!world) return reply.code(404).send({ error: 'unknown_world' });
			return worldResponse(world);
		});

		/**
		 * Rename, save over, or both.
		 *
		 * A world is not written once and renamed afterwards the way a build is — it is a
		 * document somebody keeps editing, so the save has to land on the row that already
		 * exists. POSTing each save instead would leave the library holding one world per
		 * autosave, which is the failure `in_library` was invented to keep out of `builds`.
		 */
		app.patch<{ Params: { id: string } }>(
			'/api/worlds/:id',
			{ bodyLimit: WORLD_BODY_LIMIT },
			async (request, reply) => {
				if (!requireDb(reply)) return;
				const user = await auth.requireUser(request, reply);
				if (!user) return;

				const body = request.body as { name?: unknown; settings?: unknown; terrain?: unknown } | null;
				const renaming = body?.name !== undefined;
				const saving = body?.settings !== undefined || body?.terrain !== undefined;
				if (!renaming && !saving) {
					return reply.code(400).send({ error: 'bad_request', message: 'nothing to change' });
				}

				const name = renaming ? readName(body?.name) : undefined;
				if (renaming && !name) return reply.code(400).send({ error: 'bad_name' });

				let world: ParsedWorld | undefined;
				if (saving) {
					const parsed = readWorld(body);
					if (rejected(parsed)) return reply.code(400).send(parsed);
					world = parsed;
				}

				const updated = await store!.updateWorld(request.params.id, user.id, { name, world });
				if (!updated) return reply.code(404).send({ error: 'unknown_world' });
				return { id: request.params.id };
			},
		);

		app.delete<{ Params: { id: string } }>('/api/worlds/:id', async (request, reply) => {
			if (!requireDb(reply)) return;
			const user = await auth.requireUser(request, reply);
			if (!user) return;

			// 404 rather than 403, for the reason every other delete in this file gives one: a
			// 403 confirms that the id names somebody's real world.
			const deleted = await store!.deleteWorld(request.params.id, user.id);
			if (!deleted) return reply.code(404).send({ error: 'unknown_world' });
			return { ok: true };
		});

		// --- pairing -------------------------------------------------------

		/** Session-authenticated: the player is at the website, about to attach a world. */
		app.post('/api/agent/pair-codes', async (request, reply) => {
			if (!requireDb(reply)) return;
			const user = await auth.requireUser(request, reply);
			if (!user) return;

			// The code carries the id of whoever minted it, and `claimPairCode` copies that
			// onto the agent it creates — which is how a paired world ends up owned without the
			// mod ever knowing an account exists. It is also the only thing standing between
			// "my world" and "some world on this server".
			const { code, expiresAt } = await store!.createPairCode(user.id);
			return reply.code(201).send({ code, expiresAt, expiresInSeconds: 600 });
		});

		/**
		 * Agent-token scheme — except there is not even a token yet.
		 *
		 * The only unauthenticated write in this file, and it has to be: the caller is a
		 * Minecraft server with no credential of any kind. What makes it safe is the code —
		 * six characters, ten minutes, single use, and readable only off the screen of the
		 * account that minted it. Adding a session check here would 401 the mod.
		 */
		app.post('/api/agent/claim', async (request, reply) => {
			if (!requireDb(reply)) return;

			const body = request.body as {
				code?: unknown;
				mcVersion?: unknown;
				modVersion?: unknown;
				envType?: unknown;
			} | null;

			const code = typeof body?.code === 'string' ? body.code.trim().toUpperCase() : '';
			if (!/^[A-Z0-9]{6}$/.test(code)) return reply.code(400).send({ error: 'bad_code' });

			const claimed = await store!.claimPairCode(code, {
				mcVersion: typeof body?.mcVersion === 'string' ? body.mcVersion : undefined,
				modVersion: typeof body?.modVersion === 'string' ? body.modVersion : undefined,
				envType: typeof body?.envType === 'string' ? body.envType : undefined,
			});

			// 404 rather than 401: an expired, already-used and never-existed code are
			// indistinguishable to the caller on purpose, so codes cannot be probed.
			if (!claimed) return reply.code(404).send({ error: 'unknown_or_expired_code' });

			app.log.info({ agentId: claimed.agentId }, 'agent paired');
			return { agentToken: claimed.token, agentId: claimed.agentId };
		});

		/** Session-authenticated. This is the list a stranger must never be shown. */
		app.get('/api/agent/agents', async (request, reply) => {
			if (!requireDb(reply)) return;
			const user = await auth.requireUser(request, reply);
			if (!user) return;

			const agents = await store!.listAgents(user.id);
			return {
				agents: agents.map((agent) => ({
					id: agent.id,
					name: agent.name,
					envType: agent.envType,
					mcVersion: agent.mcVersion,
					lastSeenAt: agent.lastSeenAt,
					online: hub!.isOnline(agent.id),
				})),
			};
		});

		/** Session-authenticated. */
		app.delete<{ Params: { id: string } }>('/api/agent/agents/:id', async (request, reply) => {
			if (!requireDb(reply)) return;
			const user = await auth.requireUser(request, reply);
			if (!user) return;

			// 404, not 403. A 403 would confirm that this id names a real world paired to
			// somebody, which is exactly what an id-guesser is trying to learn.
			const revoked = await store!.revokeAgent(request.params.id, user.id);
			if (!revoked) return reply.code(404).send({ error: 'unknown_agent' });

			hub!.revoke(request.params.id);
			return { ok: true };
		});

		// --- jobs ----------------------------------------------------------

		/** Session-authenticated. This route puts blocks in somebody's real game. */
		app.post('/api/agent/jobs', async (request, reply) => {
			if (!requireDb(reply)) return;
			const user = await auth.requireUser(request, reply);
			if (!user) return;

			const body = request.body as {
				agentId?: unknown;
				buildId?: unknown;
				region?: unknown;
			} | null;
			const agentId = typeof body?.agentId === 'string' ? body.agentId : '';
			const buildId = typeof body?.buildId === 'string' ? body.buildId : '';
			if (!agentId || !buildId) return reply.code(400).send({ error: 'bad_request' });

			// A region is an ordinary build as far as this route and the database are concerned —
			// it is materialised, saved and queued like any other. What the extra field carries is
			// where in the map it belongs, which nothing downstream of the hub can work out for
			// itself: the mod would otherwise centre every region of a world on whichever player
			// happened to be standing nearby, and a sixteen-region map would land as sixteen
			// buildings in a heap.
			const region = readRegion(body?.region);
			if (region === 'bad') return reply.code(400).send({ error: 'bad_region' });

			// Both sides are checked. Owning the build is not enough — that would let anyone
			// build their own creation in a stranger's world — and owning the world is not
			// enough either, or an id-guesser could build somebody else's private structure.
			const blockCount = await store!.buildSize(buildId, user.id);
			if (blockCount === null) return reply.code(404).send({ error: 'unknown_build' });
			if (!(await store!.agentExists(agentId, user.id))) {
				return reply.code(404).send({ error: 'unknown_agent' });
			}

			const created = await store!.createJob({ agentId, buildId, userId: user.id, total: blockCount });
			if ('conflict' in created) {
				return reply.code(409).send({
					error: 'agent_busy',
					message: 'that world is already building something',
					jobId: created.conflict.id,
				});
			}

			const job = await store!.getJob(created.id, user.id);
			const delivered = job ? await hub!.offer(job, region ?? undefined) : false;

			return reply.code(202).send({
				id: created.id,
				// A queued job for an offline world is normal, not an error — it lands when the
				// player next starts the game.
				delivered,
				online: hub!.isOnline(agentId),
			});
		});

		/** Session-authenticated. The mod reports its own progress over the WebSocket instead. */
		app.get<{ Params: { id: string } }>('/api/agent/jobs/:id', async (request, reply) => {
			if (!requireDb(reply)) return;
			const user = await auth.requireUser(request, reply);
			if (!user) return;

			const job = await store!.getJob(request.params.id, user.id);
			if (!job) return reply.code(404).send({ error: 'unknown_job' });
			return job;
		});

		/** Session-authenticated. */
		app.post<{ Params: { id: string } }>('/api/agent/jobs/:id/cancel', async (request, reply) => {
			if (!requireDb(reply)) return;
			const user = await auth.requireUser(request, reply);
			if (!user) return;

			const job = await store!.getJob(request.params.id, user.id);
			if (!job) return reply.code(404).send({ error: 'unknown_job' });
			hub!.cancel(job);
			await store!.updateJob(job.id, { status: 'cancelled' });
			hub!.emit(job.id, { jobId: job.id, status: 'cancelled' });
			return { ok: true };
		});

		/**
		 * The build itself, as a `.schem`.
		 *
		 * **Agent-token scheme.** The one route in this file that a browser never calls. The
		 * request comes from a Minecraft server, which has no cookie and never will, so
		 * `requireUser` here would 401 the mod and kill send-to-game end to end — and it would
		 * fail looking like a mod bug rather than an auth change. Ownership is still enforced,
		 * just by the rule that applies to a caller with no session: the job must belong to the
		 * agent presenting the token.
		 *
		 * Bulk data goes over HTTPS rather than the WebSocket so the control channel stays
		 * small, and as a schematic rather than a bespoke format so the mod can parse it with
		 * the game's own reader — the same bytes the website offers as a download.
		 */
		app.get<{ Params: { id: string } }>('/api/agent/jobs/:id/schem', async (request, reply) => {
			if (!requireDb(reply)) return;

			const token = bearer(request);
			const agent = token ? await store!.agentByToken(token) : null;
			if (!agent) return reply.code(401).send({ error: 'unauthorized' });

			const job = await store!.getJobForAgent(request.params.id);
			if (!job) return reply.code(404).send({ error: 'unknown_job' });
			// An agent may only fetch data for its own job.
			if (job.agentId !== agent.id) return reply.code(403).send({ error: 'forbidden' });

			const build = await store!.getBuildForAgent(job.buildId);
			if (!build) return reply.code(404).send({ error: 'unknown_build' });

			const grid = decodeVoxels(new Uint8Array(build.voxels));
			const bytes = writeSchematic(grid, { name: build.name });

			return reply
				.header('Content-Type', 'application/octet-stream')
				.header('Content-Disposition', `attachment; filename="${schematicFilename(build.name)}"`)
				.send(Buffer.from(bytes));
		});

		/** Session-authenticated. Live progress for the website while a bot builds. */
		app.get<{ Params: { id: string } }>('/api/agent/jobs/:id/events', async (request, reply) => {
			if (!requireDb(reply)) return;
			const user = await auth.requireUser(request, reply);
			if (!user) return;

			// Resolved before the stream opens, not inside it: subscribing first and checking
			// afterwards would push somebody else's progress down the wire for however long the
			// lookup took.
			const job = await store!.getJob(request.params.id, user.id);
			if (!job) return reply.code(404).send({ error: 'unknown_job' });

			// From here the raw socket is written directly, so Fastify must be told to stop
			// waiting for a reply it will never be given.
			reply.hijack();

			reply.raw.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache, no-transform',
				Connection: 'keep-alive',
				'X-Accel-Buffering': 'no',
			});

			const write = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);

			// Replay the job's current state immediately: a browser that connects mid-build
			// should not have to wait for the next tick to show a progress bar.
			write({
				jobId: job.id,
				status: job.status,
				placed: job.progressPlaced,
				total: job.progressTotal,
			});

			const unsubscribe = hub!.subscribe(request.params.id, (event) => {
				write(event);
				if (['done', 'cancelled', 'failed'].includes(event.status)) reply.raw.end();
			});

			request.raw.on('close', unsubscribe);
		});
	};
}
