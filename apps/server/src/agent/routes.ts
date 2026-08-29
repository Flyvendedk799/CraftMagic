/**
 * Builds, agents and jobs.
 *
 *   POST   /api/builds                     save a build (send-to-game transport, or library)
 *   GET    /api/builds                     the caller's library
 *   GET    /api/builds/:id                 one build, voxels included
 *   PATCH  /api/builds/:id                 rename
 *   DELETE /api/builds/:id                 delete
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

import { decodeVoxels, schematicFilename, writeSchematic, type VoxelGrid } from '@craftmagic/core';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Auth } from '../auth/session.js';
import type { AgentHub } from './hub.js';
import type { AgentStore } from './store.js';

export interface AgentRoutesOptions {
	store: AgentStore | null;
	hub: AgentHub | null;
	auth: Auth;
	publicOrigin: string;
}

const MAX_BUILD_NAME = 80;

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

		// --- builds — all session-authenticated ------------------------------

		app.post('/api/builds', async (request, reply) => {
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
				library?: unknown;
				grid?: { size?: { x: number; y: number; z: number }; palette?: string[]; voxels?: number[] };
			} | null;

			const name = readName(body?.name);
			if (!name) return reply.code(400).send({ error: 'bad_name' });

			const grid = body?.grid;
			if (!grid?.size || !Array.isArray(grid.palette) || !Array.isArray(grid.voxels)) {
				return reply.code(400).send({ error: 'bad_grid' });
			}

			const expected = grid.size.x * grid.size.y * grid.size.z;
			if (grid.voxels.length !== expected) {
				return reply.code(400).send({ error: 'bad_grid', message: `expected ${expected} voxels` });
			}

			const voxelGrid: VoxelGrid = {
				size: grid.size,
				palette: grid.palette,
				voxels: Uint16Array.from(grid.voxels),
			};
			let blockCount = 0;
			for (const v of voxelGrid.voxels) if (v !== 0) blockCount++;

			const { encodeVoxels } = await import('@craftmagic/core');
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
			return {
				id: build.id,
				name: build.name,
				size: grid.size,
				blockCount: build.blockCount,
				detached: build.detached,
				program: build.program,
				edits: build.edits,
				grid: { size: grid.size, palette: grid.palette, voxels: Array.from(grid.voxels) },
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

			const body = request.body as { agentId?: unknown; buildId?: unknown } | null;
			const agentId = typeof body?.agentId === 'string' ? body.agentId : '';
			const buildId = typeof body?.buildId === 'string' ? body.buildId : '';
			if (!agentId || !buildId) return reply.code(400).send({ error: 'bad_request' });

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
			const delivered = job ? await hub!.offer(job) : false;

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
