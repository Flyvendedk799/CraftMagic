/** Bounded in-memory document working copies. Never advertised as a durable save. */
export class WorkingCopies<T> {
  private readonly values = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  private readonly versions = new Map<string, number>();
  version(key: string): number {
    return this.versions.get(key) ?? 0;
  }
  invalidate(key: string): void {
    this.versions.set(key, this.version(key) + 1);
    this.delete(key);
  }
  setIfCurrent(key: string, value: T, bytes: number, version: number): void {
    if (version === this.version(key)) this.set(key, value, bytes);
  }
  constructor(
    private readonly maxEntries = 16,
    private readonly maxBytes = 64 * 1024 * 1024,
  ) {}
  get(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    this.values.delete(key);
    this.values.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T, bytes: number): void {
    this.delete(key);
    const cost = Math.max(
      0,
      Number.isFinite(bytes) ? bytes : this.maxBytes + 1,
    );
    if (cost > this.maxBytes) return;
    this.values.set(key, { value, bytes: cost });
    this.bytes += cost;
    while (this.values.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }
  delete(key: string): void {
    const old = this.values.get(key);
    if (old) this.bytes -= old.bytes;
    this.values.delete(key);
  }
  clear(): void {
    this.values.clear();
    this.bytes = 0;
  }
  get size() {
    return this.values.size;
  }
}
