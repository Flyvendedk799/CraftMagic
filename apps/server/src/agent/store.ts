/**
 * Database access for builds, agents, pairing codes and jobs.
 *
 * Three properties are enforced here rather than left to callers:
 *   * Agent tokens and session tokens are only ever stored as SHA-256 digests. Lookup is by
 *     digest, so the plaintext exists exactly once — in the reply that created it.
 *   * A pairing code is single-use and short-lived. Claiming one is a conditional UPDATE, so
 *     two mods racing on the same code cannot both win.
 *   * **Ownership is part of the query, never a check the caller might forget.** Every scoped
 *     method takes an `OwnerScope` and folds it into the WHERE clause, so a row belonging to
 *     someone else is not "found and rejected" — it is not found. That is what makes a
 *     mistake a 404 rather than a disclosure, and it is why there is no `getBuild(id)` that a
 *     route could reach for by accident. The one unscoped reader, `getBuildForAgent`, is
 *     named for the single caller allowed to use it.
 *
 * `IS NOT DISTINCT FROM` rather than `=` because the scope may be null: the anonymous pool is
 * the rows nobody owns, and `user_id = NULL` matches nothing. The cast is required — Postgres
 * cannot infer a parameter's type from a bare null.
 */

import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Db } from '../db/pool.js';
import type { OwnerScope } from '../auth/session.js';

export interface BuildRow {
	id: string;
	name: string;
	sizeX: number;
	sizeY: number;
	sizeZ: number;
	blockCount: number;
	voxels: Buffer;
	program: unknown;
	detached: boolean;
	/** The hand-edit layer, when the client saved one. Null on old rows and clean builds. */
	edits: unknown;
	/** Architecture mode plan the build was compiled from, when saved from Architecture mode. */
	plan: unknown;
}

/** A library listing entry: everything but the voxels, which are megabytes. */
export interface BuildSummary {
	id: string;
	name: string;
	sizeX: number;
	sizeY: number;
	sizeZ: number;
	blockCount: number;
	hasProgram: boolean;
	/** True when the row carries a layouter plan — the client offers "open in Architecture mode". */
	hasPlan: boolean;
	detached: boolean;
	createdAt: Date;
	updatedAt: Date;
}

export interface AgentRow {
	id: string;
	name: string;
	envType: string | null;
	mcVersion: string | null;
	modVersion: string | null;
	lastSeenAt: Date | null;
	revokedAt: Date | null;
}

export interface JobRow {
	id: string;
	agentId: string;
	buildId: string;
	status: string;
	progressPlaced: number;
	progressTotal: number;
	anchor: unknown;
	error: string | null;
}

export const ACTIVE_JOB_STATUSES = ['pending', 'offered', 'previewing', 'building'] as const;

function sha256(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}

/**
 * Six characters from an alphabet with no 0/O/1/I/L.
 *
 * A pairing code is read off a screen and typed into a chat box, so ambiguous glyphs cost
 * real user frustration for no security benefit — the entropy that matters comes from the
 * 10-minute expiry and single use, not from the character set.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode(): string {
	let code = '';
	for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
	return code;
}

export class AgentStore {
	constructor(private readonly db: Db) {}

	// --- builds ----------------------------------------------------------

	async saveBuild(input: {
		name: string;
		description?: string | null;
		sizeX: number;
		sizeY: number;
		sizeZ: number;
		blockCount: number;
		voxels: Uint8Array;
		program: unknown;
		userId?: string | null;
		detached?: boolean;
		edits?: unknown;
		plan?: unknown;
		/** False for the row "send to game" writes as transport; true for saved work. */
		inLibrary?: boolean;
	}): Promise<string> {
		const { rows } = await this.db.query<{ id: string }>(
			`INSERT INTO builds (user_id, name, description, size_x, size_y, size_z, block_count, program, voxels, detached, edits, plan, in_library)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
			 RETURNING id`,
			[
				input.userId ?? null,
				input.name,
				input.description ?? null,
				input.sizeX,
				input.sizeY,
				input.sizeZ,
				input.blockCount,
				input.program === undefined ? null : JSON.stringify(input.program),
				Buffer.from(input.voxels),
				input.detached ?? false,
				input.edits === undefined || input.edits === null ? null : JSON.stringify(input.edits),
				input.plan === undefined || input.plan === null ? null : JSON.stringify(input.plan),
				input.inLibrary ?? false,
			],
		);
		return rows[0]!.id;
	}

	/**
	 * A build by id, ignoring ownership.
	 *
	 * Only for the schematic route, which authenticates with an agent token and has no cookie
	 * to derive a scope from — the caller is a Minecraft server, not a browser. That route
	 * does its own check: the job must belong to the agent presenting the token. The name is
	 * long and specific so reaching for it by accident reads as wrong.
	 */
	async getBuildForAgent(id: string): Promise<BuildRow | null> {
		const { rows } = await this.db.query(
			`SELECT id, name, size_x, size_y, size_z, block_count, voxels, program, detached, edits, plan
			 FROM builds WHERE id = $1`,
			[id],
		);
		return rows[0] ? toBuild(rows[0]) : null;
	}

	async getBuild(id: string, scope: OwnerScope): Promise<BuildRow | null> {
		const { rows } = await this.db.query(
			`SELECT id, name, size_x, size_y, size_z, block_count, voxels, program, detached, edits, plan
			 FROM builds WHERE id = $1 AND user_id IS NOT DISTINCT FROM $2::uuid`,
			[id, scope],
		);
		return rows[0] ? toBuild(rows[0]) : null;
	}

	/** Existence in a scope, without reading megabytes of voxels to find out. */
	async buildExists(id: string, scope: OwnerScope): Promise<boolean> {
		const { rows } = await this.db.query<{ block_count: number }>(
			`SELECT block_count FROM builds WHERE id = $1 AND user_id IS NOT DISTINCT FROM $2::uuid`,
			[id, scope],
		);
		return rows.length > 0;
	}

	/** Block count in a scope, or null when the build is not the caller's. */
	async buildSize(id: string, scope: OwnerScope): Promise<number | null> {
		const { rows } = await this.db.query<{ block_count: number }>(
			`SELECT block_count FROM builds WHERE id = $1 AND user_id IS NOT DISTINCT FROM $2::uuid`,
			[id, scope],
		);
		return rows[0]?.block_count ?? null;
	}

	/** The library listing: only builds explicitly saved to it, newest first. */
	async listBuilds(scope: OwnerScope, limit = 200): Promise<BuildSummary[]> {
		const { rows } = await this.db.query(
			`SELECT id, name, size_x, size_y, size_z, block_count,
			        program IS NOT NULL AS has_program, plan IS NOT NULL AS has_plan,
			        detached, created_at, updated_at
			 FROM builds
			 WHERE user_id IS NOT DISTINCT FROM $1::uuid AND in_library
			 ORDER BY created_at DESC LIMIT $2`,
			[scope, limit],
		);
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			sizeX: row.size_x,
			sizeY: row.size_y,
			sizeZ: row.size_z,
			blockCount: row.block_count,
			hasProgram: row.has_program,
			hasPlan: row.has_plan,
			detached: row.detached,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	}

	async renameBuild(id: string, scope: OwnerScope, name: string): Promise<boolean> {
		const { rowCount } = await this.db.query(
			`UPDATE builds SET name = $3, updated_at = now()
			 WHERE id = $1 AND user_id IS NOT DISTINCT FROM $2::uuid`,
			[id, scope, name],
		);
		return (rowCount ?? 0) > 0;
	}

	async deleteBuild(id: string, scope: OwnerScope): Promise<boolean> {
		const { rowCount } = await this.db.query(
			`DELETE FROM builds WHERE id = $1 AND user_id IS NOT DISTINCT FROM $2::uuid`,
			[id, scope],
		);
		return (rowCount ?? 0) > 0;
	}

	// --- pairing ---------------------------------------------------------

	/**
	 * `userId` is required, not optional.
	 *
	 * The column is nullable and rows minted before accounts existed still have a null there,
	 * but nothing may create one now: a code with no owner claims into an agent with no owner,
	 * and an unowned agent is a Minecraft world that every signed-out visitor to a public
	 * deployment would see in their list and be able to build in.
	 */
	async createPairCode(userId: string, ttlMinutes = 10): Promise<{ code: string; expiresAt: Date }> {
		// Retry on collision rather than trusting 31^6 to be unique against live rows.
		for (let attempt = 0; attempt < 5; attempt++) {
			const code = generateCode();
			try {
				const { rows } = await this.db.query<{ expires_at: Date }>(
					`INSERT INTO pair_codes (code, user_id, expires_at)
					 VALUES ($1, $2, now() + ($3 || ' minutes')::interval)
					 RETURNING expires_at`,
					[code, userId, String(ttlMinutes)],
				);
				return { code, expiresAt: rows[0]!.expires_at };
			} catch (err) {
				if ((err as { code?: string }).code !== '23505') throw err;
			}
		}
		throw new Error('could not allocate a pairing code');
	}

	/**
	 * Claim a code and mint an agent token.
	 *
	 * The UPDATE is conditional on the code still being unclaimed and unexpired, so it is
	 * atomic: a second mod racing with the same code updates zero rows and is rejected.
	 */
	async claimPairCode(
		code: string,
		details: { mcVersion?: string; modVersion?: string; envType?: string; name?: string },
	): Promise<{ agentId: string; token: string } | null> {
		const client = await this.db.connect();
		try {
			await client.query('BEGIN');

			const claimed = await client.query<{ user_id: string | null }>(
				`UPDATE pair_codes
				 SET claimed_at = now()
				 WHERE code = $1 AND claimed_at IS NULL AND expires_at > now()
				 RETURNING user_id`,
				[code.toUpperCase()],
			);
			if (claimed.rowCount === 0) {
				await client.query('ROLLBACK');
				return null;
			}

			const token = randomBytes(32).toString('base64url');
			const envType =
				details.envType === 'dedicated' || details.envType === 'integrated' ? details.envType : null;

			const agent = await client.query<{ id: string }>(
				`INSERT INTO agents (user_id, name, token_hash, env_type, mc_version, mod_version, last_seen_at)
				 VALUES ($1, $2, $3, $4, $5, $6, now())
				 RETURNING id`,
				[
					claimed.rows[0]!.user_id,
					details.name ?? (envType === 'dedicated' ? 'Minecraft server' : 'Minecraft world'),
					sha256(token),
					envType,
					details.mcVersion ?? null,
					details.modVersion ?? null,
				],
			);

			await client.query('UPDATE pair_codes SET agent_id = $1 WHERE code = $2', [
				agent.rows[0]!.id,
				code.toUpperCase(),
			]);
			await client.query('COMMIT');

			return { agentId: agent.rows[0]!.id, token };
		} catch (err) {
			await client.query('ROLLBACK').catch(() => undefined);
			throw err;
		} finally {
			client.release();
		}
	}

	async agentByToken(token: string): Promise<AgentRow | null> {
		const { rows } = await this.db.query(
			`SELECT id, name, env_type, mc_version, mod_version, last_seen_at, revoked_at
			 FROM agents WHERE token_hash = $1 AND revoked_at IS NULL`,
			[sha256(token)],
		);
		const row = rows[0];
		if (!row) return null;
		return {
			id: row.id,
			name: row.name,
			envType: row.env_type,
			mcVersion: row.mc_version,
			modVersion: row.mod_version,
			lastSeenAt: row.last_seen_at,
			revokedAt: row.revoked_at,
		};
	}

	async touchAgent(id: string, details: { mcVersion?: string; modVersion?: string; envType?: string }): Promise<void> {
		await this.db.query(
			`UPDATE agents
			 SET last_seen_at = now(),
			     mc_version = COALESCE($2, mc_version),
			     mod_version = COALESCE($3, mod_version),
			     env_type = COALESCE($4, env_type)
			 WHERE id = $1`,
			[id, details.mcVersion ?? null, details.modVersion ?? null, details.envType ?? null],
		);
	}

	/**
	 * Plain `=`, not `IS NOT DISTINCT FROM`.
	 *
	 * An agent can no longer be created without an owner, so there is no anonymous scope to
	 * match here and the null-tolerant form would only be a way to write one back in. Rows
	 * orphaned from before accounts existed stay unmatched, which is the correct answer:
	 * nobody can prove they own them.
	 */
	async listAgents(userId: string): Promise<AgentRow[]> {
		const { rows } = await this.db.query(
			`SELECT id, name, env_type, mc_version, mod_version, last_seen_at, revoked_at
			 FROM agents
			 WHERE revoked_at IS NULL AND user_id = $1::uuid
			 ORDER BY last_seen_at DESC NULLS LAST`,
			[userId],
		);
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			envType: row.env_type,
			mcVersion: row.mc_version,
			modVersion: row.mod_version,
			lastSeenAt: row.last_seen_at,
			revokedAt: row.revoked_at,
		}));
	}

	/**
	 * Revoke, returning whether anything was revoked.
	 *
	 * The scope is in the WHERE clause, so someone else's agent updates zero rows and the
	 * caller gets a 404 — indistinguishable from an id that never existed. A 403 would confirm
	 * that the id is real and paired to somebody.
	 */
	async revokeAgent(id: string, userId: string): Promise<boolean> {
		const { rowCount } = await this.db.query(
			`UPDATE agents SET revoked_at = now()
			 WHERE id = $1 AND revoked_at IS NULL AND user_id = $2::uuid`,
			[id, userId],
		);
		return (rowCount ?? 0) > 0;
	}

	async agentExists(id: string, userId: string): Promise<boolean> {
		const { rows } = await this.db.query(
			`SELECT 1 AS ok FROM agents
			 WHERE id = $1 AND revoked_at IS NULL AND user_id = $2::uuid`,
			[id, userId],
		);
		return rows.length > 0;
	}

	// --- jobs ------------------------------------------------------------

	/**
	 * Queue a build for an agent.
	 *
	 * Refuses when the agent already has one in flight: two bots building different things
	 * in the same world at once is confusing at best and destructive at worst.
	 */
	async createJob(input: {
		agentId: string;
		buildId: string;
		userId?: string | null;
		total: number;
	}): Promise<{ id: string } | { conflict: JobRow }> {
		const active = await this.activeJob(input.agentId);
		if (active) return { conflict: active };

		const { rows } = await this.db.query<{ id: string }>(
			`INSERT INTO agent_jobs (agent_id, build_id, user_id, status, progress_total)
			 VALUES ($1, $2, $3, 'pending', $4)
			 RETURNING id`,
			[input.agentId, input.buildId, input.userId ?? null, input.total],
		);
		return { id: rows[0]!.id };
	}

	async activeJob(agentId: string): Promise<JobRow | null> {
		const { rows } = await this.db.query(
			`SELECT id, agent_id, build_id, status, progress_placed, progress_total, anchor, error
			 FROM agent_jobs
			 WHERE agent_id = $1 AND status = ANY($2)
			 ORDER BY created_at DESC LIMIT 1`,
			[agentId, ACTIVE_JOB_STATUSES],
		);
		return rows[0] ? toJob(rows[0]) : null;
	}

	/**
	 * A job by id, ignoring ownership.
	 *
	 * For the two agent-authenticated paths only — the WebSocket state report and the
	 * schematic fetch. Both then check that the job belongs to the agent presenting the token,
	 * which is the ownership rule that applies to a caller with no session.
	 */
	async getJobForAgent(id: string): Promise<JobRow | null> {
		const { rows } = await this.db.query(
			`SELECT id, agent_id, build_id, status, progress_placed, progress_total, anchor, error
			 FROM agent_jobs WHERE id = $1`,
			[id],
		);
		return rows[0] ? toJob(rows[0]) : null;
	}

	async getJob(id: string, userId: string): Promise<JobRow | null> {
		const { rows } = await this.db.query(
			`SELECT id, agent_id, build_id, status, progress_placed, progress_total, anchor, error
			 FROM agent_jobs WHERE id = $1 AND user_id = $2::uuid`,
			[id, userId],
		);
		return rows[0] ? toJob(rows[0]) : null;
	}

	async updateJob(
		id: string,
		patch: { status?: string; placed?: number; total?: number; anchor?: unknown; error?: string | null },
	): Promise<JobRow | null> {
		const { rows } = await this.db.query(
			`UPDATE agent_jobs
			 SET status          = COALESCE($2, status),
			     progress_placed = COALESCE($3, progress_placed),
			     progress_total  = COALESCE($4, progress_total),
			     anchor          = COALESCE($5, anchor),
			     error           = COALESCE($6, error),
			     updated_at      = now()
			 WHERE id = $1
			 RETURNING id, agent_id, build_id, status, progress_placed, progress_total, anchor, error`,
			[
				id,
				patch.status ?? null,
				patch.placed ?? null,
				patch.total ?? null,
				patch.anchor === undefined ? null : JSON.stringify(patch.anchor),
				patch.error ?? null,
			],
		);
		return rows[0] ? toJob(rows[0]) : null;
	}

	/** Jobs still marked in-flight from a previous process lifetime. */
	async pendingJobsFor(agentId: string): Promise<JobRow[]> {
		const { rows } = await this.db.query(
			`SELECT id, agent_id, build_id, status, progress_placed, progress_total, anchor, error
			 FROM agent_jobs
			 WHERE agent_id = $1 AND status IN ('pending','offered')
			 ORDER BY created_at`,
			[agentId],
		);
		return rows.map(toJob);
	}
}

function toBuild(row: Record<string, unknown>): BuildRow {
	return {
		id: row.id as string,
		name: row.name as string,
		sizeX: row.size_x as number,
		sizeY: row.size_y as number,
		sizeZ: row.size_z as number,
		blockCount: row.block_count as number,
		voxels: row.voxels as Buffer,
		program: row.program,
		detached: row.detached as boolean,
		edits: row.edits ?? null,
		plan: row.plan ?? null,
	};
}

function toJob(row: Record<string, unknown>): JobRow {
	return {
		id: row.id as string,
		agentId: row.agent_id as string,
		buildId: row.build_id as string,
		status: row.status as string,
		progressPlaced: row.progress_placed as number,
		progressTotal: row.progress_total as number,
		anchor: row.anchor,
		error: (row.error as string | null) ?? null,
	};
}
