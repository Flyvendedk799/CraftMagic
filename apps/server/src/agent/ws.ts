import {
	AGENT_PROTOCOL_VERSION,
	parseAgentMessage,
	type ServerToAgent,
} from '@craftmagic/core';
import type { FastifyPluginAsync } from 'fastify';
import type { AgentHub } from './hub.js';
import type { AgentStore } from './store.js';

const HEARTBEAT_MS = 30_000;

export interface AgentWsOptions {
	store: AgentStore | null;
	hub: AgentHub | null;
}

/**
 * The agent socket.
 *
 * The connection is always dialled *out* by the logical server inside Minecraft, so no
 * player has to open a port. Authentication is a bearer token minted during pairing; the
 * token is compared by digest, and an unauthenticated socket is closed before it can do
 * anything except learn that it is unauthenticated.
 */
export function registerAgentWs(options: AgentWsOptions): FastifyPluginAsync {
	return async (app) => {
		app.get('/agent/ws', { websocket: true }, (socket, request) => {
			const log = app.log.child({ scope: 'agent-ws', ip: request.ip });
			let heartbeatId = 0;
			let alive = true;
			let agentId: string | null = null;

			const send = (message: ServerToAgent) => {
				if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
			};

			const connection = {
				get agentId() {
					return agentId ?? '';
				},
				agentName: '',
				send,
				close: () => socket.close(),
			};

			const heartbeat = setInterval(() => {
				if (!alive) {
					log.info({ agentId }, 'agent missed heartbeat, closing');
					socket.terminate();
					return;
				}
				alive = false;
				send({ t: 'ping', id: ++heartbeatId });
			}, HEARTBEAT_MS);

			socket.on('message', (raw: Buffer) => {
				const message = parseAgentMessage(raw.toString('utf8'));
				if (!message) {
					log.warn('discarded malformed frame');
					return;
				}

				// Everything except the handshake requires an authenticated socket.
				if (message.t !== 'hello' && agentId === null) {
					send({ t: 'hello.error', reason: 'bad_token', message: 'send hello first' });
					socket.close();
					return;
				}

				void handle(message);
			});

			async function handle(message: ReturnType<typeof parseAgentMessage>): Promise<void> {
				if (!message) return;

				switch (message.t) {
					case 'hello': {
						if (message.protocolVersion !== AGENT_PROTOCOL_VERSION) {
							send({
								t: 'hello.error',
								reason: 'unsupported_protocol',
								message: `server speaks protocol ${AGENT_PROTOCOL_VERSION}, mod speaks ${message.protocolVersion} — update the mod`,
							});
							socket.close();
							return;
						}

						if (!options.store || !options.hub) {
							send({
								t: 'hello.error',
								reason: 'bad_token',
								message: 'this server has no database configured, so pairing is unavailable',
							});
							socket.close();
							return;
						}

						// The token rides on the Authorization header rather than in the hello
						// frame, so it never lands in a message log.
						const header = request.headers.authorization ?? '';
						const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
						const agent = token ? await options.store.agentByToken(token) : null;

						if (!agent) {
							send({
								t: 'hello.error',
								reason: 'bad_token',
								message: 'this world is not paired — run /craftmagic pair <code> again',
							});
							socket.close();
							return;
						}

						agentId = agent.id;
						connection.agentName = agent.name;
						await options.store.touchAgent(agent.id, {
							mcVersion: message.mcVersion,
							modVersion: message.modVersion,
							envType: message.envType,
						});

						log.info(
							{ agentId, mcVersion: message.mcVersion, envType: message.envType },
							'agent connected',
						);
						send({ t: 'hello.ok', agentName: agent.name, limits: { maxVolume: 500_000 } });

						await options.hub.attach(connection);
						return;
					}

					case 'pong':
						alive = true;
						return;

					case 'job.ack':
						log.info({ jobId: message.jobId }, 'agent acknowledged job');
						return;

					case 'job.state': {
						if (!options.store || !options.hub || !agentId) return;

						const job = await options.store.getJobForAgent(message.jobId);
						// Only the agent the job belongs to may move it, or one paired world
						// could drive another's build.
						if (!job || job.agentId !== agentId) {
							log.warn({ jobId: message.jobId, agentId }, 'ignoring state for a job this agent does not own');
							return;
						}

						const updated = await options.store.updateJob(message.jobId, {
							status: message.state,
							placed: message.progress?.placed,
							total: message.progress?.total,
							anchor: message.anchor,
							error: message.error ?? null,
						});

						options.hub.emit(message.jobId, {
							jobId: message.jobId,
							status: message.state,
							placed: message.progress?.placed,
							total: message.progress?.total,
							anchor: message.anchor,
							error: message.error ?? null,
						});

						if (updated && ['done', 'cancelled', 'failed'].includes(message.state)) {
							log.info({ jobId: message.jobId, state: message.state }, 'job finished');
						}
						return;
					}
				}
			}

			socket.on('close', () => {
				clearInterval(heartbeat);
				if (agentId && options.hub) options.hub.detach(agentId, connection);
				log.info({ agentId }, 'agent disconnected');
			});

			socket.on('error', (err: Error) => {
				log.error({ err, agentId }, 'agent socket error');
			});
		});

		/**
		 * Plain echo, kept permanently as the deployment smoke test: it proves an upgrade
		 * survives the tunnel without needing a paired agent or a database.
		 */
		app.get('/agent/ws-echo', { websocket: true }, (socket) => {
			socket.on('message', (raw: Buffer) => socket.send(raw.toString('utf8')));
		});
	};
}
