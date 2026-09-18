/** Un solo ingresso per utente, anche da socket differenti. */
export class SeatGate {
  private pending = new Set<string>();
  async run<T>(userId: string, job: () => T | Promise<T>): Promise<T> {
    if (this.pending.has(userId)) throw new Error('Ingresso gia in corso.');
    this.pending.add(userId);
    try { return await job(); } finally { this.pending.delete(userId); }
  }
}
