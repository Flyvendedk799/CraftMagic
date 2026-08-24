/**
 * Wire protocol between the ImagineCraft server and an in-game agent (the Fabric mod).
 *
 * The socket is a thin *control* channel only. Bulk voxel data is fetched over HTTPS as
 * `.schem` bytes — the same format the website exports and WorldEdit reads — so there is
 * no bespoke binary codec to keep in sync on the Java side.
 *
 * The connection always belongs to the logical server: the integrated server in
 * singleplayer, or the dedicated server process. It dials out to us, so no player has to
 * open a port.
 */

export const AGENT_PROTOCOL_VERSION = 1;

export type JobState = 'previewing' | 'building' | 'done' | 'cancelled' | 'failed';

export type AgentEnvType = 'integrated' | 'dedicated';

export interface JobProgress {
  placed: number;
  total: number;
}

export interface BuildAnchor {
  x: number;
  y: number;
  z: number;
  /** Quarter-turns around Y applied to the structure before placing. */
  rotation: 0 | 1 | 2 | 3;
}

/** Messages sent by the mod. */
export type AgentToServer =
  | {
      t: 'hello';
      protocolVersion: number;
      modVersion: string;
      mcVersion: string;
      envType: AgentEnvType;
    }
  | { t: 'job.ack'; jobId: string }
  | {
      t: 'job.state';
      jobId: string;
      state: JobState;
      progress?: JobProgress;
      anchor?: BuildAnchor;
      error?: string | null;
    }
  | { t: 'pong'; id: number };

/** Messages sent by the server. */
export type ServerToAgent =
  | {
      t: 'hello.ok';
      agentName: string;
      limits: { maxVolume: number };
    }
  | {
      t: 'hello.error';
      reason: 'unsupported_protocol' | 'bad_token' | 'revoked';
      message: string;
    }
  | {
      t: 'job.offer';
      jobId: string;
      buildId: string;
      name: string;
      size: { x: number; y: number; z: number };
      blockCount: number;
      /** Relative to the server's public origin; fetch with the agent token. */
      dataUrl: string;
    }
  | { t: 'job.cancel'; jobId: string }
  | { t: 'session.revoked' }
  | { t: 'ping'; id: number };

export type AgentMessage = AgentToServer | ServerToAgent;

/**
 * Parse an inbound frame. Returns null rather than throwing, because a malformed frame
 * from a third-party client is expected traffic, not an exceptional condition.
 */
export function parseAgentMessage(raw: string): AgentToServer | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const t = (value as { t?: unknown }).t;
  if (typeof t !== 'string') return null;
  switch (t) {
    case 'hello':
    case 'job.ack':
    case 'job.state':
    case 'pong':
      return value as AgentToServer;
    default:
      return null;
  }
}
