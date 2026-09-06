/**
 * The undo stack, once, for all three modes.
 *
 * What each mode *stores* differs for good reasons that are argued where they live: the editor
 * keeps `EditOp` deltas because a 200k-block grid is 400 KB and snapshotting one per edit spends
 * 40 MB to preserve a kilobyte of information; Architecture keeps whole plans because a few
 * hundred rooms is a few KB and a diff would cost more than the copy; World keeps column deltas
 * because a 1024² heightfield is 3 MB, and snapshots only for the resize that genuinely rewrites
 * it. Those choices stay.
 *
 * What did not differ — and was written out twice anyway — is everything around them: the two
 * parallel arrays, the cursor, the redo-tail truncation, the two ceilings, eviction from the
 * bottom. The copies had already drifted. `editor/history.ts` guarded eviction with
 * `length > 1`, explaining that an entry larger than the whole byte ceiling would otherwise
 * evict itself and leave an edit on screen that cannot be undone; `world/history.ts` had no such
 * guard, and its resize snapshots are the largest entries in the product. Fixing that in one
 * place and having it stay fixed is the point of this file.
 *
 * Two ceilings rather than one, for the reason the editor first wrote down: a depth limit alone
 * cannot bound memory when a single entry may be a whole map, and a byte limit alone lets ten
 * thousand tiny entries pile up until every undo is a linear walk. Whichever binds first wins.
 */

export interface HistoryLimits {
  maxEntries?: number;
  maxBytes?: number;
}

/**
 * A bounded undo stack over entries of any shape.
 *
 * The stack never applies anything. Reverting an `EditOp`, restoring a plan and writing a column
 * delta back are three different operations owned by three different callers, and keeping them
 * out means this has no opinion about grids, React or the DOM and is testable without any.
 */
export class History<T> {
  /** Oldest first. Entries below `cursor` are applied; entries from it up are the redo tail. */
  private readonly entries: T[] = [];
  /**
   * Cost per entry, parallel to `entries`. Kept rather than recomputed because eviction has to
   * subtract a cost from a stack that may already be a hundred deep, and re-measuring would turn
   * every push into an O(depth) walk.
   */
  private readonly costs: number[] = [];

  private cursor = 0;
  private total = 0;

  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(
    /** What one entry costs, in bytes. The only thing that varies between the three modes. */
    private readonly costOf: (entry: T) => number,
    limits: HistoryLimits = {},
  ) {
    this.maxEntries = Math.max(1, limits.maxEntries ?? 100);
    this.maxBytes = Math.max(1, limits.maxBytes ?? 64 * 1024 * 1024);
  }

  get canUndo(): boolean {
    return this.cursor > 0;
  }

  get canRedo(): boolean {
    return this.cursor < this.entries.length;
  }

  /** Entries on the stack, undo tail plus redo tail. Diagnostics only. */
  get depth(): number {
    return this.entries.length;
  }

  /** Total payload currently retained. */
  get bytes(): number {
    return this.total;
  }

  /**
   * Record an entry that has already been applied.
   *
   * Pushing after an undo discards the redo tail. Anything else means keeping a redo that would
   * replay onto state its own `before` no longer describes — the branch is unreachable from
   * here, so it is dropped rather than kept as a booby trap.
   */
  push(entry: T): void {
    for (let i = this.entries.length - 1; i >= this.cursor; i--) this.total -= this.costs[i]!;
    this.entries.length = this.cursor;
    this.costs.length = this.cursor;

    const cost = this.costOf(entry);
    this.entries.push(entry);
    this.costs.push(cost);
    this.total += cost;
    this.cursor++;

    this.evict();
  }

  /** The entry to revert, or null at the bottom of the stack. The caller applies it. */
  undo(): T | null {
    if (!this.canUndo) return null;
    this.cursor--;
    return this.entries[this.cursor] ?? null;
  }

  /** The entry to re-apply, or null if nothing was undone. */
  redo(): T | null {
    if (!this.canRedo) return null;
    const entry = this.entries[this.cursor] ?? null;
    this.cursor++;
    return entry;
  }

  clear(): void {
    this.entries.length = 0;
    this.costs.length = 0;
    this.cursor = 0;
    this.total = 0;
  }

  /**
   * Drop the oldest entries until both ceilings hold.
   *
   * `length > 1` rather than `length > 0`: an entry that is on its own bigger than the byte
   * ceiling would otherwise evict itself the moment it was pushed, leaving a change on screen
   * that cannot be undone. Keeping it costs one entry's worth of overshoot and keeps undo
   * honest — which matters most for exactly the entries big enough to trip it, since those are
   * the resizes and the map-wide fills nobody wants to be stuck with.
   */
  private evict(): void {
    while (
      this.entries.length > 1 &&
      (this.entries.length > this.maxEntries || this.total > this.maxBytes)
    ) {
      this.total -= this.costs.shift()!;
      this.entries.shift();
      if (this.cursor > 0) this.cursor--;
    }
  }
}
