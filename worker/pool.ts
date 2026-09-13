/** The durable Store is the backlog. This pool owns only running reservations, never a second
 * in-memory waiting queue. Reservation happens synchronously before the first await. */
export class BoundedPool {
  private readonly tasks = new Map<string, Promise<void>>();
  private accepting = true;
  constructor(readonly capacity: number, private readonly onError: (error: unknown) => void) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('pool capacity must be a positive safe integer');
  }
  get size(): number { return this.tasks.size; }
  has(id: string): boolean { return this.tasks.has(id); }
  /** Capacity misses remain in the durable Store; this pool never owns async waiters. */
  get waiting(): number { return 0; }
  get available(): number { return this.accepting ? this.capacity - this.size : 0; }

  tryRun(id: string, work: () => Promise<void>): boolean {
    if (!this.accepting || this.tasks.has(id) || this.size >= this.capacity) return false;
    const task = Promise.resolve().then(work).catch(error => {
      // Reporting must not create an unhandled rejection or leak the reservation.
      try { this.onError(error); } catch { /* a failed reporter cannot break pool cleanup */ }
    }).finally(() => { this.tasks.delete(id); });
    this.tasks.set(id, task);
    return true;
  }
  stop(): void { this.accepting = false; }
  async drain(): Promise<void> {
    this.stop();
    await Promise.all(this.tasks.values());
  }
}
