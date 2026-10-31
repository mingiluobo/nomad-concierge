interface BreakerPermit { readonly generation: number; readonly probe: boolean }
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private generation = 0;
  private probing: BreakerPermit | null = null;
  constructor(private readonly threshold: number, private readonly cooldownMs: number, private readonly now: () => number = Date.now) {}
  available(): boolean { return this.openedAt === null || (this.probing === null && this.now() - this.openedAt >= this.cooldownMs); }
  acquire(): BreakerPermit | null {
    if (!this.available()) return null;
    const permit = { generation: this.generation, probe: this.openedAt !== null };
    if (permit.probe) this.probing = permit;
    return permit;
  }
  private current(permit: BreakerPermit): boolean { return permit.generation === this.generation && (!permit.probe || permit === this.probing); }
  success(permit: BreakerPermit): void {
    if (!this.current(permit)) return;
    this.failures = 0; this.openedAt = null; this.probing = null;
    if (permit.probe) this.generation += 1;
  }
  failure(permit: BreakerPermit): void {
    if (!this.current(permit)) return;
    this.failures += 1;
    if (permit.probe || this.failures >= this.threshold) { this.openedAt = this.now(); this.generation += 1; }
    if (permit === this.probing) this.probing = null;
  }
  interrupted(permit: BreakerPermit): void { if (permit === this.probing) this.probing = null; }
}
