/**
 * Wire protocol between the CraftMagic server and an in-game agent (the Fabric mod).
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
  /**
   * Which dimension it went into, as a dimension key — `minecraft:overworld` and the rest.
   *
   * Optional, because a mod older than worlds does not send it and a lone build never needed
   * it: the coordinates alone say where that build landed. A world does need it. Its later
   * regions are placed with no player involved, so nothing else is left to say which of the
   * three levels the first region chose, and a hub begun in the nether would otherwise
   * continue itself into the overworld.
   */
  dimension?: string;
}

/**
 * What one job is allowed to be. Announced in `hello.ok`.
 *
 * Named as a type rather than written inline because it is now load-bearing on both sides:
 * the server enforces it before an offer goes out instead of announcing a bound and then
 * queueing whatever it likes.
 */
export interface AgentLimits {
  maxVolume: number;
}

export const AGENT_LIMITS: AgentLimits = { maxVolume: 500_000 };

/**
 * A build that is one tile of a world rather than a thing in its own right.
 *
 * A world — a server hub, a map — is far larger than one job may be, so it reaches the game
 * as a run of ordinary builds, one per region, and this is what tells the mod that the run is
 * a run. Optional throughout: an offer without it means "put this house here", which is what
 * every offer meant before worlds existed and what most offers still mean.
 *
 * `offset` is in blocks relative to the world anchor, expressed in the world's own unrotated
 * frame. The mod turns it by the anchor's rotation before adding it, because the player who
 * placed region 0 turned the whole map and not merely its first tile.
 */
export interface JobRegion {
  worldId: string;
  /** Zero-based position in the run. Region 0 is the one a player places by hand. */
  index: number;
  total: number;
  /** Coordinates in the world's region grid, for the sentence the player reads in chat. */
  rx: number;
  rz: number;
  offset: { x: number; y: number; z: number };
  /**
   * Where region 0 of this world ended up, carried back down from its `job.state`.
   *
   * Absent on region 0, which has nothing to be relative to yet; present on every region
   * after it, and the server refuses to offer one until it is. A region with no anchor has
   * nothing to offset from and would be centred on whichever player happened to be standing
   * somewhere when it arrived — which is the whole bug this field exists to close.
   */
  anchor?: BuildAnchor;
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
      limits: AgentLimits;
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
      /**
       * Set only when this build is one region of a world.
       *
       * Its absence is the legacy case and has to stay byte-identical on the wire: a mod that
       * predates worlds reads the fields it knows and ignores the rest, and a server that
       * started emitting an empty object here would be sending a field older mods would have
       * to be trusted to ignore for no gain.
       */
      region?: JobRegion;
    }
  | { t: 'job.cancel'; jobId: string }
  | { t: 'session.revoked' }
  | { t: 'ping'; id: number };

export type AgentMessage = AgentToServer | ServerToAgent;

/**
 * Whether a reported anchor is one the server may build on.
 *
 * The rest of an inbound frame is taken on trust, because the worst a lying agent can do with
 * it is misreport its own progress. An anchor is different now: it is the origin every later
 * region of a world is measured from, so a rotation of `7` or an x of `NaN` would not be a bad
 * status line, it would be a map scattered across the world it was meant to fill.
 */
export function isBuildAnchor(value: unknown): value is BuildAnchor {
  if (typeof value !== 'object' || value === null) return false;
  const anchor = value as Record<string, unknown>;
  for (const axis of ['x', 'y', 'z'] as const) {
    if (typeof anchor[axis] !== 'number' || !Number.isFinite(anchor[axis])) return false;
  }
  if (anchor.rotation !== 0 && anchor.rotation !== 1 && anchor.rotation !== 2 && anchor.rotation !== 3) {
    return false;
  }
  return anchor.dimension === undefined || typeof anchor.dimension === 'string';
}

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
